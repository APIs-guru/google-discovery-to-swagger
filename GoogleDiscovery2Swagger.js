#!/usr/bin/env node
"use strict";

var assert = require('assert')
var _ = require('underscore');
var URI = require('URIjs');
var Client = require('node-rest-client').Client;
var Tool = require('swagger-tools').specs.v2;
var mime = require('mime-types');
var jp = require('jsonpath');
var api = require('json-schema-compatibility');
var fs = require('fs');

function validateSwagger(swagger, cb) {
  //Trick to get rid of undefined properties
  var strSwagger = JSON.stringify(swagger, null, 2);
  swagger = JSON.parse(strSwagger);

  return Tool.validate(swagger, function (validationError, validationResults) {
    if (validationError) {
      console.log(validationError);
      process.exit(1);
    }

    if (validationResults && validationResults.errors && validationResults.errors.length) {
      console.log(strSwagger);
      console.log(validationResults.errors);
      process.exit(1);
    }
    cb(strSwagger);
  });
}

if (!process.argv[2]) {
  console.log("missing directory name");
  process.exit(1);
}

mkdirSafe(process.argv[2]);
process.chdir(process.argv[2]);

var discovery = new Client();
discovery.get("https://www.googleapis.com/discovery/v1/apis", processList);

function processList(data,response) {
   data = JSON.parse(data);
   assert.equal(data.kind, 'discovery#directoryList')
   assert.equal(data.discoveryVersion, 'v1')

   //FIXME: data.preferred

   data.items.map(function (api) {
     discovery.get(api.discoveryRestUrl, processAPI);
   });
}

function processAPI(data) {
   data = JSON.parse(data);

   assert.equal(data.kind, 'discovery#restDescription')
   assert.equal(data.discoveryVersion, 'v1')
   assert.equal(data.protocol, 'rest')

   if ([
         //missing API description
         "cloudlatencytest:v2",
         //asterisk in path
         "admin:directory_v1",
         //plus in path
         "pubsub:v1beta1",
         "pubsub:v1beta1a",
         "pubsub:v1beta2",
         //FIXME: bug with default value, not matching enum definition
         "blogger:v3",
         "youtube:v3",
         //FIXME
         //circular reference in MapFolder/MapItem
         "mapsengine:exp2",
         "mapsengine:v1",
       ].indexOf(data.id) >= 0) {
      return;
   }

   //fields that doesn't map to anything:
   //	id
   //	name
   //	revision
   //	icons
   //	batchPath

   //deprecated:
   //	baseUrl
   //	basePath

   //FIXME:
   //console.log(data.labels);
   //features

   var rootUrl = URI(data.rootUrl);
   var srGlobalRefParameters = [];
   var srGlobalParameters = processGlobalParameters(data.parameters, srGlobalRefParameters);

   var swagger = {
     swagger: "2.0",
     info: {
       title: data.title,
       description: data.description,
       contact: {
         name: data.ownerName,
         url: 'https://' + data.ownerDomain,
       },
       version: data.version,
     },
     host: rootUrl.host(),
     basePath: "/" + data.servicePath.replace(/^\/|\/$/, ""),
     schemes: [rootUrl.scheme()],
     externalDocs: {
       url: data.documentationLink,
     },
     paths: processResource(data, srGlobalRefParameters),
     definitions: processDefinitions(data.schemas),
     parameters: srGlobalParameters,
   };

   //if ("auth" in data) {
   //  assert("oauth2" in data.auth);

   //  _.extend(swagger, {
   //    security: {
   //    },
   //    securityDefinitions: {
   //      type: "oauth2",
   //    }
   //  });
   //  var auth = data.auth;
   //  var srSecurity = {
   //  };

   //  swagger.security = srSecurity;
   //}
   validateSwagger(swagger, function (str) {
     saveSwagger(data.name, data.version, str);
   });
}

function saveSwagger(name, version, swagger) {
  var path = name + '/';
  mkdirSafe(path);
  path += version + '/';
  mkdirSafe(path);
  path += 'swagger.json'
  fs.writeFileSync(path, swagger)
  console.log(path);
}

function mkdirSafe(path) {
  try {
    fs.mkdirSync(path);
  } catch (e) {
    if (e.code !== 'EEXIST')
      throw e;
  }
}

function processGlobalParameters(parameters, srGlobalRefParameters) {
  var srGlobalParameters = {};
  for (var name in parameters) {
    srGlobalParameters[name] = processParameter(name, parameters[name]);
    srGlobalRefParameters.push({$ref: '#/parameters/' + name});
  }
  return srGlobalParameters;
}

function fixRef(ref) {
  return "#/definitions/" + ref;
}

function processDefinitions(schemas) {
  if (schemas == undefined)
    return undefined;

  schemas = api.v4(schemas);
  jp.apply(schemas, "$..*['$ref']" , function (value) {
    //if $ref isn't string it mean that this isn't reference
    //it something called '$ref', this happens in "discovery:v1".
    if (typeof value !== "string")
      return value;
    return fixRef(value);
  });

  jp.apply(schemas, "$..*.type" , function (value) {
    if (value === "any")
      return undefined;
    return value;
  });

  //Google for some reason code minimum/maximum as strings
  function convertInt(value) {
    if (typeof value === "string")
      return parseInt(value);
    return value;
  }
  jp.apply(schemas, "$..*.minimum" , convertInt);
  jp.apply(schemas, "$..*.maximum" , convertInt);

  return schemas;
}

function processResource(resources, srGlobalRefParameters, srPaths) {
  srPaths = srPaths || {};
  //Process methods
  if ("methods" in resources) {
    for (var key in resources.methods) {
      var method = resources.methods[key];
      var srPath = "/" + method.path;
      var srOperation = method.httpMethod.toLowerCase();

      if (!(srPath in srPaths))
        srPaths[srPath] = { parameters: srGlobalRefParameters };
      srPaths[srPath][srOperation] = processMethod(method);
    }
  }

  //Process recursive resources
  if ("resources" in resources)
    for (var key in resources.resources)
      processResource(resources.resources[key], srGlobalRefParameters, srPaths);

  return srPaths;
}

function convertMime(list) {
  var result = [];
  _.each(list, function (pattern) {
    _.each(mime.glob(pattern), function (name) {
      //FIXME: workaround for https://github.com/swagger-api/swagger-spec/issues/268
      if (name.indexOf("_") >= 0)
        return;
      result.push(name);
    });
  });
  return result;
}

function processMethod(method) {
   var srResponse = {
     description: "Successful response",
   };

   var srMethod = {
     description: method.description,
     operationId: method.id,
     responses: {
       200 : srResponse
     },
   };

   //TODO: test on youtube example
   if (method.supportsMediaUpload) {
     srMethod.consumes = convertMime(method.mediaUpload.accept);
     //TODO: rest of fields in 'mediaUpload'
   }

   //FIXME: https://code.google.com/p/google-api-go-client/issues/detail?id=16
   //assert(!method.hasOwnProperty('supportsMediaDownload'))
   //FIXME: supportsSubscription
   //FIXME: oath

   if ("parameters" in method)
     srMethod.parameters = processParameterList(method);

   //FIXME:
   //assert(!("request" in method));

   if ("response" in method) {
     assert("$ref" in method.response);
     srResponse.schema = {
       $ref: fixRef(method.response.$ref)
     };
   }

   return srMethod;
}

function processParameterList(method) {
   var parameters = method.parameters;
   var paramOrder = method.paramOreder || [];

   var srParameters = paramOrder.map(function (name) {
     return processParameter(name, parameters[name])
   });

   for (var name in parameters) {
     if (paramOrder.indexOf(name) !== -1)
       continue;
     var srParam = processParameter(name, parameters[name])
     srParameters.push(srParam);
   }

   return srParameters;
}

function processParameter(name, param) {

  assert(!('$ref' in param));
  assert(param.location == 'query' || param.location == 'path');
  assert(["string", "number", "integer", "boolean"].indexOf(param.type) >= 0);
  assert(!("properties" in param));
  assert(!("additionalProperties" in param));
  assert(!("annotations" in param));

  var srParam = {
    name: name,
    in: param.location,
    description: param.description,
    required: param.required,
    default: param.default
  };

  var srType = srParam;
  if (param.repeated === true) {
    srType = {}
    _.extend(srParam, {
      type: "array",
      items: srType,
      //FIXME: test
      collectionFormat: ((srParam.in === "path") ? "csv" : "multi")
    });
  }

  _.extend(srType, {
    type: param.type,
    enum: param.enum,
    minimum: (param.minimum ? parseInt(param.minimum) : undefined),
    maximum: (param.maximum ? parseInt(param.maximum) : undefined)
  });

  //FIXME: enumDescriptions
  if ("format" in param) {
    //FIXME: convert format.
  }

  return srParam;
}

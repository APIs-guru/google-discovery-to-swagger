'use strict';

var assert = require('assert')
var _ = require('lodash');
var URI = require('URIjs');
var mime = require('mime-types');
var api = require('json-schema-compatibility');
var jp = require('jsonpath');
var traverse = require('traverse');

exports.convert = function (data) {
  assert.equal(data.discoveryVersion, 'v1')
  assert.equal(data.protocol, 'rest')

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
    swagger: '2.0',
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
    basePath: '/' + data.servicePath.replace(/^\/|\/$/, ''),
    schemes: [rootUrl.scheme()],
    externalDocs: {
      url: data.documentationLink,
    },
    paths: processResource(data, srGlobalRefParameters),
    definitions: processDefinitions(data.schemas),
    parameters: srGlobalParameters,
    securityDefinitions: processAuth(data.auth)
  };

  removeUndefined(swagger);
  return swagger;
}

function processAuth(auth) {
  if (auth === undefined)
    return undefined;

  //For now Google use only Oauth2.0
  assert(Object.keys(auth).length == 1);
  assert(Object.keys(auth)[0] === 'oauth2');

  var scopes = auth.oauth2.scopes;
  var srScopes = {};
  for (var name in scopes)
    srScopes[name] = scopes[name].description;

  return {
    Oauth2: {
      type: 'oauth2',
      description: 'Oauth 2.0 authentication',
      flow: 'implicit',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
      scopes: srScopes
    }
  };
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
  return '#/definitions/' + ref;
}

function processDefinitions(schemas) {
  if (schemas == undefined)
    return undefined;

  schemas = api.v4(schemas);
  jp.apply(schemas, '$..*["$ref"]' , function (value) {
    //if $ref isn't string it mean that this isn't reference
    //it something called '$ref', this happens in 'discovery:v1'.
    if (typeof value !== 'string')
      return value;
    return fixRef(value);
  });

  jp.apply(schemas, '$..*.type' , function (value) {
    if (value === 'any')
      return undefined;
    return value;
  });

  //Google for some reason code minimum/maximum as strings
  function convertInt(value) {
    if (typeof value === 'string')
      return parseInt(value);
    return value;
  }
  jp.apply(schemas, '$..*.minimum' , convertInt);
  jp.apply(schemas, '$..*.maximum' , convertInt);

  return schemas;
}

function processResource(resources, srGlobalRefParameters, srPaths) {
  srPaths = srPaths || {};
  //Process methods
  if ('methods' in resources) {
    for (var key in resources.methods) {
      var method = resources.methods[key];
      var srPath = '/' + method.path;
      var srOperation = method.httpMethod.toLowerCase();

      if (!(srPath in srPaths))
        srPaths[srPath] = { parameters: srGlobalRefParameters };
      srPaths[srPath][srOperation] = processMethod(method);
    }
  }

  //Process recursive resources
  if ('resources' in resources)
    for (var key in resources.resources)
      processResource(resources.resources[key], srGlobalRefParameters, srPaths);

  return srPaths;
}

function convertMime(list) {
  var result = [];
  _.each(list, function (pattern) {
    _.each(mime.glob(pattern), function (name) {
      //TODO: workaround for https://github.com/swagger-api/swagger-spec/issues/268
      if (name.indexOf('_') >= 0)
        return;
      result.push(name);
    });
  });
  return result;
}

function processMethod(method) {
  var srResponse = {
    description: 'Successful response',
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

  if ('parameters' in method)
    srMethod.parameters = processParameterList(method);

  //FIXME:
  //assert(!('request' in method));

  if ('response' in method) {
    assert('$ref' in method.response);
    srResponse.schema = {
      $ref: fixRef(method.response.$ref)
    };
  }

  if ('scopes' in method)
    srMethod.security = [{ Oauth2: method.scopes}];

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
  assert(['string', 'number', 'integer', 'boolean'].indexOf(param.type) >= 0);
  assert(!('properties' in param));
  assert(!('additionalProperties' in param));
  assert(!('annotations' in param));
  fixDefault(param);

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
      type: 'array',
      items: srType,
      //FIXME: test
      collectionFormat: ((srParam.in === 'path') ? 'csv' : 'multi')
    });
  }

  _.extend(srType, {
    type: param.type,
    enum: param.enum,
    minimum: (param.minimum ? parseInt(param.minimum) : undefined),
    maximum: (param.maximum ? parseInt(param.maximum) : undefined)
  });

  //FIXME: enumDescriptions
  if ('format' in param) {
    //FIXME: convert format.
  }

  return srParam;
}

function fixDefault(param) {
  //Google for some reason encode default values for enums like that
  //SOME_PREFIX_VALUE
  //That mean we need convert to lower case and strip prefix.
  if ('enum' in param && typeof param.default === 'string' &&
     param.enum.indexOf(param.default) == -1)
  {
    var lower = param.default.toLowerCase();
    var candidate;
    _.each(param.enum, function (value) {
      if (lower.slice(-value.length) == value) {
         assert(candidate === undefined);
         candidate = value;
      }
    });
    assert(candidate !== undefined);
    param.default = candidate;
  }
}

function removeUndefined(obj) {
  traverse(obj).forEach(function (value) {
    if (value === undefined)
      this.remove()
  });
}

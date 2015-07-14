'use strict';

var assert = require('assert');
var _ = require('lodash');
var URI = require('URIjs');
var mimeDB = require('mime-db');
var jsonCompat = require('json-schema-compatibility');
var jp = require('jsonpath');
var traverse = require('traverse');

exports.checkFormat = function (data) {
  return !_.isUndefined(data.discoveryVersion);
};

exports.getVersion = function (data) {
  return data.discoveryVersion;
};

exports.convert = function (data) {
  assert(exports.checkFormat(data));
  assert(exports.getVersion(data) === 'v1');
  assert.equal(data.protocol, 'rest');

  //fields that doesn't map to anything:
  //	id
  //	revision
  //	icons
  //	batchPath
  //	labels
  //	features

  //deprecated:
  //	baseUrl
  //	basePath

  var rootUrl = URI(data.rootUrl);
  var srGlobalRefParameters = [];
  var srGlobalParameters = processGlobalParameters(data.parameters, srGlobalRefParameters);

  var swagger = {
    swagger: '2.0',
    info: {
      title: data.title,
      'x-serviceName': data.name,
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
    paths: processResource(data, srGlobalRefParameters),
    definitions: processDefinitions(data.schemas),
    parameters: srGlobalParameters,
    securityDefinitions: processAuth(data.auth)
  };

  if (data.documentationLink)
    swagger.externalDocs = { url: data.documentationLink };

  removeUndefined(swagger);
  return swagger;
};

function processAuth(auth) {
  if (auth === undefined)
    return undefined;

  //For now Google use only Oauth2.0
  assert(Object.keys(auth).length === 1);
  assert(Object.keys(auth)[0] === 'oauth2');

  return {
    Oauth2: {
      type: 'oauth2',
      description: 'Oauth 2.0 authentication',
      flow: 'implicit',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
      scopes: _.mapValues(auth.oauth2.scopes, 'description')
    }
  };
}

function processGlobalParameters(parameters, srGlobalRefParameters) {
  var srGlobalParameters = {};
  _.each(parameters, function (param, name) {
    srGlobalParameters[name] = processParameter(name, param);
    srGlobalRefParameters.push({$ref: '#/parameters/' + name});
  });
  return srGlobalParameters;
}

function fixRef(ref) {
  return '#/definitions/' + ref;
}

function applyOnProperty(schema, name, type, cb) {
  var path = '$..*["' + name + '"]';
  jp.apply(schema, path , function (value) {
    if (typeof value !== type)
      return value;
    return cb(value);
  });
}


function processDefinitions(schemas) {
  if (schemas === undefined)
    return undefined;

  schemas = jsonCompat.v4(schemas);
  applyOnProperty(schemas, '$ref', 'string', fixRef);

  //HACK: Swagger doesn't support full JSON Schema
  applyOnProperty(schemas, 'id', 'string', _.noop);
  applyOnProperty(schemas, 'enumDescriptions', 'object', function (value) {
    if (_.isArray(value))
      return undefined;
    return value;
  });
  applyOnProperty(schemas, 'annotations', 'object', function (value) {
    var keys = _.keys(value);
    if (_.isEqual(keys, ['required']) && _.isArray(value.required))
      return undefined;
    return value;
  });

  //TODO: delete, after PR will be acepted
  applyOnProperty(schemas, 'type', 'string', function (value) {
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

  _.each(schemas, function (schema) {
    if (!('properties' in schema))
      return;

    _.each(schema.properties, function (property) {
      if ('default' in property) {
        property.default = processDefault(property);
      }
    });
  });

  return schemas;
}

function processResource(data, srGlobalRefParameters) {
  var srPaths = processMethodList(data);

  if ('resources' in data) {
    _.each(data.resources, function (subResource, name) {
      var srSubPaths = processSubResource(data.resources[name]);

      //Add top-level resource name as tag to all sub-methods.
      _.each(srSubPaths, function (srPath) {
        _.each(srPath, function (srOperation) {
          srOperation.tags = [name];
        });
      });

      srPaths = _.merge(srPaths, srSubPaths);
    });
  }

  //Add reference to global parameters
  _.each(srPaths, function (srPath) {
    srPath.parameters = srGlobalRefParameters;
  });
  return srPaths;
}

function processMethodList(data) {
  if (!('methods' in data))
    return {};

  var srPaths = {};
  for (var key in data.methods) {
    var method = data.methods[key];
    var httpMethod = method.httpMethod.toLowerCase();
    var path = method.path;
    if (path[0] !== '/')
      path = '/' + path;

    if (!(path in srPaths))
      srPaths[path] = { };
    srPaths[path][httpMethod] = processMethod(method);
  }
  return srPaths;
}

function processSubResource(data) {
  var srPaths = processMethodList(data);

  if (!('resources' in data))
    return srPaths;

  _.each(data.resources, function (resource, name) {
    var srSubPaths = processSubResource(resource);
    srPaths = _.merge(srPaths, srSubPaths);
  });
  return srPaths;
}

function globMime(pattern) {
  if (pattern === '*/*')
    return ['application/octet-stream'];

  var slashIdx = pattern.indexOf('/');
  if (slashIdx === -1 || pattern.slice(slashIdx + 1) !== '*')
    return [pattern];

  var prefix = pattern.slice(0,slashIdx+1);
  var result = [];
  _.each(mimeDB, function (dummy, name) {
    if (name.slice(0, slashIdx+1) === prefix)
      result.push(name);
  })
  return result;
}

function convertMime(list) {
  var result = [];
  _.each(list, function (pattern) {
    _.each(globMime(pattern), function (name) {
      //skip duplicates
      if (result.indexOf(name) !== -1)
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

  //TODO: implement file upload/download
  //  * rest of fields in 'mediaUpload'
  //  * 'supportsMediaDownload' https://code.google.com/p/google-api-go-client/issues/detail?id=16
  if (method.supportsMediaUpload)
    srMethod.consumes = convertMime(method.mediaUpload.accept);

  //TODO: convert data.supportsSubscription

  var srParameters = processParameterList(method);

  if ('request' in method) {
    var request = method.request;
    srParameters.push({
      name: request.parameterName || 'body',
      in: 'body',
      schema: processSchemaRef(request)
    });
  }

  if (!_.isEmpty(srParameters))
    srMethod.parameters = srParameters;

  if ('response' in method)
    srResponse.schema = processSchemaRef(method.response);

  if ('scopes' in method)
    srMethod.security = [{ Oauth2: method.scopes}];

  return srMethod;
}

function processSchemaRef(data) {
  assert('$ref' in data);
  return {
    $ref: fixRef(data.$ref)
  };
}

function processParameterList(method) {
  var parameters = method.parameters || [];
  var paramOrder = method.parameterOrder || [];

  //First push parameters based on 'paramOreder' field
  var srParameters = _.map(paramOrder, function (name) {
    return processParameter(name, parameters[name]);
  });

  //When process all parameters that doesn't have order
  _(parameters).omit(paramOrder).each(function (param, name) {
    var srParam = processParameter(name, param);
    srParameters.push(srParam);
  }).value();

  return srParameters;
}

function processParameter(name, param) {
  assert(!('$ref' in param));
  assert(param.location === 'query' || param.location === 'path');
  assert(['string', 'number', 'integer', 'boolean'].indexOf(param.type) >= 0);
  assert(!('properties' in param));
  assert(!('additionalProperties' in param));
  assert(!('annotations' in param));

  var srParam = {
    name: name,
    in: param.location,
    description: param.description,
    required: param.required,
    default: processDefault(param)
  };

  if (param.repeated) {
    _.extend(srParam, {
      type: 'array',
      items: processType(param),
      collectionFormat: ((srParam.in === 'path') ? 'csv' : 'multi')
    });
  }
  else
    _.extend(srParam, processType(param));

  return srParam;
}

function processType(type) {
  var srType = {
    type: type.type,
    enum: type.enum,
    minimum: (type.minimum ? parseInt(type.minimum) : undefined),
    maximum: (type.maximum ? parseInt(type.maximum) : undefined)
  };

  //TODO: convert format.
  //if ('format' in type) {

  //TODO: use strings from type.enumDescriptions
  return srType;
}


function processDefault(param) {
  if (!('default' in param))
    return undefined;

  assert(_.isString(param.default));
  if (param.type !== 'string')
    param.default = JSON.parse(param.default);

  assert.equal({
    number: 'number',
    integer: 'number',
    boolean: 'boolean',
    string: 'string'
  }[param.type], typeof param.default);

  //Google for some reason encode default values for enums like that
  //SOME_PREFIX_VALUE
  //That mean we need convert to lower case and strip prefix.
  if ('enum' in param && param.enum.indexOf(param.default) === -1)
  {
    var lower = param.default.toLowerCase();
    var candidate;
    _.each(param.enum, function (value) {
      if (lower.slice(-value.length) === value) {
         assert(candidate === undefined);
         candidate = value;
      }
    });
    //If we can't fix default when return undefined and remove it.
    return candidate;
  }
  return param.default;
}

function removeUndefined(obj) {
  traverse(obj).forEach(function (value) {
    if (value === undefined)
      this.remove();
  });
}

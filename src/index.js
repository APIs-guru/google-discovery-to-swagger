'use strict';

var assert = require('assert');
var _ = require('lodash');
var URI = require('urijs');
var MimeLookup = require('mime-lookup');
var MIME = new MimeLookup(require('mime-db'));
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
  assert.ok(exports.checkFormat(data), 'discoveryVersion is undefined');
  assert.equal(exports.getVersion(data), 'v1', 'GDD version is not \'v1\'');
  assert.equal(data.protocol, 'rest', 'Protocol is not \'rest\'');

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

  var rootUrl = URI(data.rootUrl || '');
  var srGlobalRefParameters = [];
  var srGlobalParameters = processGlobalParameters(data.parameters, srGlobalRefParameters);
  var options = {
    supportsMediaUpload: _.some(jp.query(data.resources, '$..supportsMediaUpload')),
    basePath: '/' + data.servicePath.replace(/^\/|\/$/, '')
  };

  var swagger = _.assign({
    swagger: '2.0',
    info: {
      title: data.title,
      description: data.description,
      contact: {
        name: data.ownerName,
        url: 'https://' + data.ownerDomain,
      },
      version: data.version,
      license: {
        name: 'Creative Commons Attribution 3.0',
        url: 'http://creativecommons.org/licenses/by/3.0/'
      },
      termsOfService: 'https://developers.google.com/terms/'
    },
    host: rootUrl.host(),
    basePath: (options.supportsMediaUpload ? '' : options.basePath),
    schemes: [rootUrl.scheme()],
    definitions: processDefinitions(data.schemas),
    parameters: srGlobalParameters,
    securityDefinitions: processAuth(data.auth)
  }, processResource(data, srGlobalRefParameters, options));

  if (data.documentationLink)
    swagger.externalDocs = { url: data.documentationLink };

  removeUndefined(swagger);
  return swagger;
};

function processAuth(auth) {
  if (auth === undefined)
    return undefined;

  //For now Google use only Oauth2.0
  assert.equal(Object.keys(auth).length, 1, 'auth section does not exist');
  assert.equal(Object.keys(auth)[0], 'oauth2', 'auth type not supported');

  return {
    //TODO: apiKeys - see https://github.com/APIs-guru/openapi-directory/issues/35
    Oauth2: {
      type: 'oauth2',
      description: 'Oauth 2.0 authentication',
      flow: 'implicit',
	  //TODO: accessCode flow - see https://github.com/APIs-guru/openapi-directory/issues/135
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
	  //TODO: tokenUrl - see https://github.com/APIs-guru/openapi-directory/pull/116/commits/86cc66063b2a373731d816ea459a508dd27b426c
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
  if (ref.indexOf('.json') == -1) {
    return '#/definitions/' + ref;
  } else {
    return ref;
  }
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

function processResource(data, srGlobalRefParameters, options) {
  var srTags = [];
  var srPaths = processMethodList(data, options);

  if ('resources' in data) {
    _.each(data.resources, function (subResource, name) {
      var srSubPaths = processSubResource(data.resources[name], options);

      //Add top-level resource name as tag to all sub-methods.
      _.each(srSubPaths, function (srPath) {
        if (!_.some(srTags, ['name', name]))
          srTags.push({name: name});

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
  return {paths: srPaths, tags: _.uniq(srTags)};
}

function processMethodList(data, options) {
  if (!('methods' in data))
    return {};

  var srPaths = {};
  for (var key in data.methods) {
    var method = data.methods[key];

    var httpMethod = method.httpMethod.toLowerCase();
    var path = method.path;

    if (path[0] !== '/')
      path = '/' + path;

    if (options.supportsMediaUpload)
      path = options.basePath + path;

    // fix broken "complex" paths
    path = path.replaceAll("{+", "{");

    if (!(path in srPaths))
      srPaths[path] = { };
    srPaths[path][httpMethod] = processMethod(method);

    if (method.supportsMediaUpload) {
      var mediaUploadPaths = processMediaUpload(method);
      srPaths = _.merge(srPaths, mediaUploadPaths)
    }
  }
  return srPaths;
}

function processSubResource(data, options) {
  var srPaths = processMethodList(data, options);

  if (!('resources' in data))
    return srPaths;

  _.each(data.resources, function (resource, name) {
    var srSubPaths = processSubResource(resource, options);
    srPaths = _.merge(srPaths, srSubPaths);
  });
  return srPaths;
}

function convertMime(list) {
  var result = [];
  _.each(list, function (pattern) {
    _.each(MIME.glob(pattern), function (name) {
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

  //TODO: implement file upload/download - see https://github.com/APIs-guru/openapi-directory/issues/26
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

  if ('scopes' in method) {
    srMethod.security = _.map(method.scopes, function (scope) {
      return {
        Oauth2: [scope]
      };
    });
  }

  return srMethod;
}

function processMediaUpload(method) {
  var paths = {};
  var method = method;

  _.each(method.mediaUpload.protocols, function (mediaUploadProtocol, key) {
    var path = mediaUploadProtocol.path;
    var response = {
      description: 'Successful response'
    };
    var m = {
      description: method.description,
      operationId: method.id + '.' + key,
      responses: {
        200 : response
      }
    };

    if (mediaUploadProtocol.multipart) {
      m.consumes = ['multipart/form-data'];
    }

    var parameters = processParameterList(method);

    switch (key) {
      case 'simple':
        if ('request' in method) {
          var request = method.request;
          parameters.push({
            description: 'Upload type. Must be "multipart".',
            name: 'uploadType',
            in: 'query',
            type: 'string',
            enum: [
              'multipart'
            ],
            required: true
          });
          parameters.push({
            description: request.$ref  + ' metadata.',
            name: 'metadata',
            in: 'body',
            schema: processSchemaRef(request),
            required: true
          });
          parameters.push({
            description: 'The file to upload.',
            name: 'data',
            in: 'formData',
            type: 'file',
            required: true
          });
        }

        if ('response' in method)
          response.schema = processSchemaRef(method.response);

        break;
      case 'resumable':
        if ('request' in method) {
          var request = method.request;
          parameters.push({
            description: 'Upload type. Must be "resumable".',
            in: 'query',
            name: 'uploadType',
            type: 'string',
            enum: [
              'resumable'
            ],
            required: true
          });
          parameters.push({
            name: request.parameterName || 'body',
            in: 'body',
            schema: processSchemaRef(request)
          });
        }
    }

    if (!_.isEmpty(parameters))
      m.parameters = parameters;

    if ('scopes' in method) {
      m.security = _.map(method.scopes, function (scope) {
        return {
          Oauth2: [scope]
        };
      });
    }

    if (!(path in paths))
      paths[path] = { };

    paths[path]['post'] = m;
  });

  return paths;
}

function processSchemaRef(data) {
  assert.ok('$ref' in data, 'schema reference does not contain $ref');
  return {
    $ref: fixRef(data.$ref)
  };
}

function processParameterList(method) {
  var parameters = method.parameters || [];
  var paramOrder = method.parameterOrder || [];

  //First push parameters based on 'paramOreder' field
  var srParameters = _.map(paramOrder, function (name) {
    assert.ok(parameters[name], 'Undefined param used inside \'parameterOrder\': ' + name);
    return processParameter(name, parameters[name]);
  });

  //When process all parameters that doesn't have order
  _(parameters).omit(paramOrder).each(function (param, name) {
    var srParam = processParameter(name, param);
    srParameters.push(srParam);
  });

  return srParameters;
}

function processParameter(name, param) {
  assert.ok(!('$ref' in param), 'parameter cannot contain $ref: '+param);
  assert.ok(['query', 'path'].indexOf(param.location) > -1, 'parameter type must be \'query\' or \'path\'');
  assert.ok(['string', 'number', 'integer', 'boolean'].indexOf(param.type) >= 0, 'type specified not supported');
  assert.ok(!('properties' in param), 'parameters cannot contain properties');
  assert.ok(!('additionalProperties' in param), 'parameters cannot contain additionalProperties');
  assert.ok(!('annotations' in param), 'properties cannot contain annotations');

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

  // Sometimes, the default value for a boolean is not a string
  if (param.type === 'boolean' && !_.isString(param.default))
    param.default = '' + param.default;

  assert.ok(_.isString(param.default), 'default parameter must be a string: '+param);
  if (param.type !== 'string')
    param.default = JSON.parse(param.default);

  assert.equal({
    number: 'number',
    integer: 'number',
    boolean: 'boolean',
    string: 'string'
  }[param.type], typeof param.default, 'parameter must be number, boolean, string');

  //Google for some reason encode default values for enums like that
  //SOME_PREFIX_VALUE
  //That mean we need convert to lower case and strip prefix.
  if ('enum' in param && param.enum.indexOf(param.default) === -1)
  {
    var lower = param.default.toLowerCase();
    var candidate;
    _.each(param.enum, function (value) {
      if (lower.slice(-value.length) === value) {
         assert.equal(candidate, undefined, 'unable to derive default');
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

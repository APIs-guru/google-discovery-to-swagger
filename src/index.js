//@ts-check
'use strict';

const assert = require('assert');
const _ = require('lodash');
const URI = require('urijs');
const MimeLookup = require('mime-lookup');
const MIME = new MimeLookup(require('mime-db'));
const jsonCompat = require('json-schema-compatibility');
const jp = require('jsonpath');
const traverse = require('traverse');
const sortObject = require('deep-sort-object');

let strict = true;
let paramMap = {};

exports.checkFormat = function (data) {
  return !_.isUndefined(data.discoveryVersion);
};

exports.getVersion = function (data) {
  return data.discoveryVersion;
};

exports.setStrict = function(value) {
  strict = value;
};

exports.convert = function (data) {
  assert.ok(exports.checkFormat(data), 'discoveryVersion is undefined');
  assert.equal(exports.getVersion(data), 'v1', 'GDD version is not \'v1\'');
  assert.equal(data.protocol, 'rest', 'Protocol is not \'rest\'');

  data = sortObject(data);

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

  let rootUrl = URI(data.rootUrl || '');
  let srGlobalRefParameters = [];
  let srGlobalParameters = processGlobalParameters(data.parameters, srGlobalRefParameters);

  let swagger = _.assign({
    openapi: '3.0.0',
    info: {
      title: data.title,
      description: data.description,
      contact: {
        name: data.ownerName,
        url: 'https://' + data.ownerDomain
      },
      version: data.version,
      license: {
        name: 'Creative Commons Attribution 3.0',
        url: 'http://creativecommons.org/licenses/by/3.0/'
      },
      termsOfService: 'https://developers.google.com/terms/'
    },
    servers: [ {
      url: rootUrl.scheme()+'://'+rootUrl.host()+'/'+data.servicePath.replace(/^\/|\/$/, '')
    } ],
    components: {
      schemas: processDefinitions(data.schemas),
      parameters: srGlobalParameters,
      securitySchemes: processAuth(data.auth)
    }
  }, processResource(data, srGlobalRefParameters));

  if (data.documentationLink)
    swagger.externalDocs = { url: data.documentationLink.trim() };

  removeUndefined(swagger);

  const paths = {};
  for (let p in swagger.paths) {
    let pCount = 0;
    const template = p.replace(/\{(.+?)\}/g, function (match, group1) {
      return '{'+(pCount++)+'}';
    });
    if (paths[template]) {
      swagger['x-hasEquivalentPaths'] = true;
    }
    paths[template] = true;
  }

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
      description: 'Oauth 2.0 implicit authentication',
      flows: {
        implicit: {
          authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
          scopes: _.mapValues(auth.oauth2.scopes, 'description')
        }
      }
    },
    Oauth2c: {
      type: 'oauth2',
      description: 'Oauth 2.0 authorizationCode authentication',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
          tokenUrl: 'https://accounts.google.com/o/oauth2/token',
          scopes: _.mapValues(auth.oauth2.scopes, 'description')
        }
      }
    }
  };
}

function sanitise(s) {
    if (paramMap[s]) return paramMap[s];
    s = s.replace('[]','Array');
    let components = s.split('/');
    components[0] = components[0].replace(/[^A-Za-z0-9_\-\.]+|\s+/gm, '_');
    paramMap[s] = components.join('/');
    return paramMap[s];
}

function processGlobalParameters(parameters, srGlobalRefParameters) {
  let srGlobalParameters = {};
  _.each(parameters, function (param, name) {
    let newName = sanitise(name);
    srGlobalParameters[newName] = processParameter(name, param);
    srGlobalRefParameters.push({$ref: '#/components/parameters/' + newName});
  });
  return srGlobalParameters;
}

function fixRef(ref) {
  if (ref.indexOf('.json') === -1) {
    return '#/components/schemas/' + ref;
  } else {
    return ref;
  }
}

function applyOnProperty(schema, name, type, cb) {
  let path = '$..*["' + name + '"]';
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
    let keys = _.keys(value);
    if (_.isEqual(keys, ['required']) && _.isArray(value.required))
      return undefined;
    return value;
  });

  //Google for some reason code minimum/maximum as strings
  function convertInt(value) {
    if (typeof value === 'string')
      return parseInt(value, 10);
    return value;
  }
  jp.apply(schemas, '$..*.minimum' , convertInt);
  jp.apply(schemas, '$..*.maximum' , convertInt);

  _.each(schemas, function (schema) {
    traverse(schema).forEach(function (value) {
      if ((typeof value === 'object') && ('default' in value)) {
        if ((value.type === 'boolean') && (typeof value.default === 'string')) {
          value.default = (value.default === 'true');
        }
        else if ((value.type === 'integer') && (typeof value.default === 'string')) {
          value.default = parseInt(value.default, 10);
        }
        value.default = processDefault(value);
      }
    });
  });

  return schemas;
}

function pcomp(e1,e2) {
  function id(e) {
    return (e.$ref+'\t'+e.name+'\t'+e.in);
  }
  return (id(e1) === id(e2));
}

function processResource(data, srGlobalRefParameters) {
  let srTags = [];
  let srPaths = processMethodList(data);

  if ('resources' in data) {
    _.each(data.resources, function (subResource, name) {
      let srSubPaths = processSubResource(data.resources[name]);

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

  if (strict) {
    for (let p in srPaths) {
      let newP = p.split('{+').join('{');
      if (newP !== p) {
        srPaths[newP] = srPaths[p];
        delete srPaths[p];
      }
    }
  }

  //Add reference to global parameters
  _.each(srPaths, function (srPath) {
    srPath.parameters = _.uniqWith(_.cloneDeep(srGlobalRefParameters),pcomp);
  });
  return {paths: srPaths, tags: _.uniq(srTags)};
}

function processMethodList(data) {
  if (!('methods' in data))
    return {};

  let srPaths = {};
  for (let key in data.methods) {
    let method = data.methods[key];
    let httpMethod = method.httpMethod.toLowerCase();
    let path = method.path;
    if (path[0] !== '/')
      path = '/' + path;

    if (!(path in srPaths))
      srPaths[path] = { };
    srPaths[path][httpMethod] = processMethod(method);
  }
  return srPaths;
}

function processSubResource(data) {
  let srPaths = processMethodList(data);

  if (!('resources' in data))
    return srPaths;

  _.each(data.resources, function (resource, name) {
    let srSubPaths = processSubResource(resource);
    srPaths = _.merge(srPaths, srSubPaths);
  });
  return srPaths;
}

function convertMime(list) {
  let result = [];
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
  let srResponse = {
    description: 'Successful response'
  };

  let srMethod = {
    description: method.description,
    operationId: method.id,
    responses: {
      200 : srResponse
    }
  };

  //TODO: implement file upload/download - see https://github.com/APIs-guru/openapi-directory/issues/26
  //  * rest of fields in 'mediaUpload'
  //  * 'supportsMediaDownload' https://code.google.com/p/google-api-go-client/issues/detail?id=16
  let consumes = [ 'application/json' ]; // FIXME?
  if (method.supportsMediaUpload)
    consumes = convertMime(method.mediaUpload.accept);

  //TODO: convert data.supportsSubscription

  let srParameters = processParameterList(method);

  if ('request' in method) {
    srMethod.requestBody = { content: {} };
    for (let mediatype of consumes) {
      srMethod.requestBody.content[mediatype] = { schema: processSchemaRef(method.request) };
    }
  }

  srParameters = _.uniqWith(srParameters, pcomp);

  if (!_.isEmpty(srParameters))
    srMethod.parameters = srParameters;

  if ('response' in method) {
    srResponse.content = { 'application/json': { schema: processSchemaRef(method.response) } };
  }

  if ('scopes' in method) {
    srMethod.security = _.map(method.scopes, function (scope) {
      return {
        Oauth2: [scope],
        Oauth2c: [scope]
      };
    });
  }

  return srMethod;
}

function processSchemaRef(data) {
  assert.ok('$ref' in data, 'schema reference does not contain $ref');
  return {
    $ref: fixRef(data.$ref)
  };
}

function processParameterList(method) {
  let parameters = method.parameters || [];
  let paramOrder = _.uniq(method.parameterOrder || []);

  //First push parameters based on 'parameterOrder' field
  let srParameters = _.map(paramOrder, function (name) {
    assert.ok(parameters[name], 'Undefined param used inside \'parameterOrder\': ' + name);
    return processParameter(name, parameters[name]);
  });

  //Then process all parameters that don't have order
  let srParameters2 = [];
  _(parameters).omit(paramOrder).each(function (param, name) {
    const srParam = processParameter(name, param);
    srParameters2.push(srParam);
  });

  srParameters2 = srParameters2.sort(function(a,b){
    if (a.name < b.name) return -1;
    if (a.name > b.name) return +1;
    return 0;
  });

  let allParameters = srParameters.concat(srParameters2);
  return _.uniqWith(allParameters, pcomp);
}

function processParameter(name, param) {
  assert.ok(!('$ref' in param), 'parameter cannot contain $ref: '+param);
  assert.ok(['query', 'path'].indexOf(param.location) > -1, 'parameter type must be \'query\' or \'path\'');
  assert.ok(['string', 'number', 'integer', 'boolean'].indexOf(param.type) >= 0, 'type specified not supported');
  assert.ok(!('properties' in param), 'parameters cannot contain properties');
  assert.ok(!('additionalProperties' in param), 'parameters cannot contain additionalProperties');
  assert.ok(!('annotations' in param), 'properties cannot contain annotations');

  let srParam = {
    name: name,
    in: param.location,
    description: param.description,
    required: param.required,
    schema: {
    }
  };

  if (param.repeated) {
    _.extend(srParam.schema, {
      type: 'array',
      items: processType(param)
    });
    _.extend(srParam, {
      style: (srParam.in === 'path') ? 'simple' : 'form',
      explode: ((srParam.in === 'path') ? false : true)
    });
  }
  else
    _.extend(srParam.schema, processType(param));

  _.extend(srParam.schema, { default: processDefault(srParam.schema) });

  assert.ok(!(('schema' in srParam) && ('type' in srParam)), 'output parameter cannot contain schema and type');

  return srParam;
}

function processType(type) {
  let srType = {
    type: type.type,
    enum: type.enum,
    minimum: (type.minimum ? parseInt(type.minimum, 10) : undefined),
    maximum: (type.maximum ? parseInt(type.maximum, 10) : undefined)
  };

  //TODO: convert format.
  //if ('format' in type) {

  //TODO: use strings from type.enumDescriptions
  return srType;
}

function processDefault(param) {
  if (!('default' in param))
    return undefined;
  if ((typeof param.type === 'object') || (typeof param.type === 'undefined'))
    return undefined;

  //assert.ok(_.isString(param.default), 'default parameter must be a string: '+param);
  //if (param.type !== 'string')
  //  param.default = JSON.parse(param.default);

  assert.equal({
    number: 'number',
    integer: 'number',
    boolean: 'boolean',
    string: 'string',
    object: 'object'
  }[param.type], typeof param.default, `default mismatch. ${param.type} and ${typeof param.default}`);

  //Google for some reason encode default values for enums like that
  //SOME_PREFIX_VALUE
  //That means we need convert to lower case and strip prefix.
  if ('enum' in param && param.enum.indexOf(param.default) === -1)
  {
    let lower = param.default.toLowerCase();
    let candidate;
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
    if ((this.key === 'parameters') && (Array.isArray(value))) {
      this.update(_.uniqWith(value,pcomp));
    }
  });
}

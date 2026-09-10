import { SmartRouteHandler } from '@/route-handlers/smart-route-handler';
import { CrudlOperation, EndpointDocumentation } from '@hexclave/shared/dist/crud';
import { WebhookEvent } from '@hexclave/shared/dist/interface/webhooks';
import { yupNumber, yupObject, yupString } from '@hexclave/shared/dist/schema-fields';
import { HexclaveAssertionError, throwErr } from '@hexclave/shared/dist/utils/errors';
import { HttpMethod } from '@hexclave/shared/dist/utils/http';
import { typedEntries, typedFromEntries } from '@hexclave/shared/dist/utils/objects';
import { deindent, stringCompare } from '@hexclave/shared/dist/utils/strings';
import * as yup from 'yup';

function isInternalApiPath(path: string) {
  return path === '/internal' || path.startsWith('/internal/');
}

export function parseOpenAPI(options: {
  endpoints: Map<string, Map<HttpMethod, SmartRouteHandler>>,
  audience: 'client' | 'server' | 'admin',
}) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Hexclave REST API',
      version: '1.0.0',
      description: 'The Hexclave REST API. All request headers are documented as canonical `X-Hexclave-*`; the equivalent `X-Stack-*` aliases are accepted on every endpoint for backwards compatibility. Response headers `X-Hexclave-actual-status`, `X-Hexclave-known-error`, and `X-Hexclave-request-id` are emitted alongside their legacy `X-Stack-*` equivalents.',
    },
    servers: [{
      url: 'https://api.hexclave.com/api/v1',
      description: 'Hexclave REST API',
    }],
    paths: Object.fromEntries(
      [...options.endpoints]
        // `/internal/*` routes are scoped to the internal Hexclave project (project.id === "internal")
        // and are not part of the public API. Many of them use a permissive auth.type (e.g. adaptSchema),
        // so the per-audience heuristic below does not exclude them; filter them out explicitly here so
        // they never leak into the public API reference, regardless of their individual route metadata.
        .filter(([path]) => !isInternalApiPath(path))
        .map(([path, handlersByMethod]) => (
          [path, Object.fromEntries(
            [...handlersByMethod]
              .map(([method, handler]) => (
                [method.toLowerCase(), parseRouteHandler({ handler, method, path, audience: options.audience })]
              ))
              .filter(([_, handler]) => handler !== undefined)
          )]
        ))
        .filter(([_, handlersByMethod]) => Object.keys(handlersByMethod).length > 0)
        .sort(([pathA, handlersByMethodA], [pathB, handlersByMethodB]) => {
          const tagComparison = stringCompare((Object.values(handlersByMethodA)[0] as any).tags[0] ?? "", (Object.values(handlersByMethodB)[0] as any).tags[0] ?? "");
          if (tagComparison !== 0) {
            return tagComparison;
          }
          return stringCompare(pathA, pathB);
        }),
    ),
  };
}

export function parseWebhookOpenAPI(options: {
  webhooks: readonly WebhookEvent<any>[],
}) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Hexclave Webhooks API',
      version: '1.0.0',
    },
    webhooks: options.webhooks.reduce((acc, webhook) => {
      return {
        ...acc,
        [webhook.type]: {
          post: {
            ...parseOverload({
              metadata: webhook.metadata,
              method: 'POST',
              path: `/webhooks/${webhook.type}`,
              requestBodyDesc: undefinedIfMixed(yupObject({
                type: yupString().defined().meta({ openapiField: { description: webhook.type, exampleValue: webhook.type } }),
                data: webhook.schema.defined(),
              }).describe()) || yupObject().describe(),
              responseVariants: [{
                responseTypeDesc: yupString().oneOf(['json']).describe(),
                statusCodeDesc: yupNumber().oneOf([200]).describe(),
              }],
            }),
            operationId: webhook.type,
            summary: webhook.type,
          }
        },
      };
    }, {}),
  };
}

function undefinedIfMixed(value: yup.SchemaFieldDescription | undefined): yup.SchemaFieldDescription | undefined {
  if (!value) return undefined;
  return value.type === 'mixed' ? undefined : value;
}

function isSchemaObjectDescription(value: yup.SchemaFieldDescription): value is yup.SchemaObjectDescription & { type: 'object' } {
  return value.type === 'object';
}

function isSchemaMixedDescription(value: yup.SchemaFieldDescription): value is yup.SchemaDescription & { type: 'mixed' } {
  return value.type === 'mixed';
}

function isFieldNullable(field: yup.SchemaFieldDescription): boolean {
  // `SchemaFieldDescription` is a union, and its ref/lazy members don't carry a `nullable` flag.
  // Narrow with an `in` check before reading it; ref/lazy descriptions are treated as non-nullable here.
  return "nullable" in field && field.nullable;
}

function isSchemaArrayDescription(value: yup.SchemaFieldDescription): value is yup.SchemaInnerTypeDescription & { type: 'array', innerType: yup.SchemaInnerTypeDescription } {
  return value.type === 'array';
}

function isSchemaTupleDescription(value: yup.SchemaFieldDescription): value is yup.SchemaInnerTypeDescription & { type: 'tuple', innerType: yup.SchemaInnerTypeDescription[] } {
  return value.type === 'tuple';
}

function isSchemaStringDescription(value: yup.SchemaFieldDescription): value is yup.SchemaDescription & { type: 'string' } {
  return value.type === 'string';
}

function isSchemaNumberDescription(value: yup.SchemaFieldDescription): value is yup.SchemaDescription & { type: 'number' } {
  return value.type === 'number';
}

function assertResolvedSchemaDescription(value: yup.SchemaFieldDescription): asserts value is yup.SchemaDescription {
  if (!("nullable" in value)) {
    throw new HexclaveAssertionError('OpenAPI generator cannot process unresolved schema descriptions', { actual: value });
  }
}

function isMaybeRequestSchemaForAudience(requestDescribe: yup.SchemaObjectDescription, audience: 'client' | 'server' | 'admin') {
  const schemaAuth = requestDescribe.fields.auth;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- yup types are wrong and claim that fields always exist
  if (!schemaAuth) return true;
  if (isSchemaMixedDescription(schemaAuth)) return true;
  if (!isSchemaObjectDescription(schemaAuth)) return true;
  const schemaAudience = schemaAuth.fields.type;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- same as above
  if (!schemaAudience) return true;
  if ("oneOf" in schemaAudience && schemaAudience.oneOf.length > 0) {
    return schemaAudience.oneOf.includes(audience);
  }
  return true;
}

function parseRouteHandler(options: {
  handler: SmartRouteHandler,
  path: string,
  method: HttpMethod,
  audience: 'client' | 'server' | 'admin',
}) {
  let result: ReturnType<typeof parseOverload> | undefined;

  for (const overload of options.handler.overloads.values()) {
    if (overload.metadata?.hidden) continue;

    const requestDescribe = overload.request.describe();
    if (!isSchemaObjectDescription(requestDescribe)) throw new Error('Request schema must be a yup.ObjectSchema');

    // estimate whether this overload is the right one based on a heuristic
    if (!isMaybeRequestSchemaForAudience(requestDescribe, options.audience)) {
      // This overload is definitely not for the audience
      continue;
    }

    if (result) {
      throw new HexclaveAssertionError(deindent`
        OpenAPI generator matched multiple overloads for audience ${options.audience} on endpoint ${options.method} ${options.path}.
        
        This does not necessarily mean there is a bug in the endpoint; the OpenAPI generator uses a heuristic to pick the allowed overloads, and may pick too many. Currently, this heuristic checks whether the request.auth.type property in the schema is a yup.string.oneOf(...) and matches it to the expected audience of the schema. If there are multiple overloads matching a single audience, for example because none of the overloads specify request.auth.type, the OpenAPI generator will not know which overload to generate specs for, and hence fails.
        
        Either specify request.auth.type on the schema of the specified endpoint or update the OpenAPI generator to support your use case. 
      `);
    }

    const responseSchemaInfo = overload.response.meta()?.hexclaveSchemaInfo;
    const responseSchemas: yup.AnySchema[] = responseSchemaInfo?.type === "union" ? responseSchemaInfo.items : [overload.response];

    result = parseOverload({
      metadata: overload.metadata,
      method: options.method,
      path: options.path,
      pathDesc: undefinedIfMixed(requestDescribe.fields.params),
      parameterDesc: undefinedIfMixed(requestDescribe.fields.query),
      headerDesc: undefinedIfMixed(requestDescribe.fields.headers),
      requestBodyDesc: undefinedIfMixed(requestDescribe.fields.body),
      responseVariants: responseSchemas.map((schema) => {
        const responseDescribe = schema.describe();
        if (!isSchemaObjectDescription(responseDescribe)) {
          throw new Error('Response schema must be a yup.ObjectSchema');
        }
        return {
          responseDesc: undefinedIfMixed(responseDescribe.fields.body),
          responseTypeDesc: undefinedIfMixed(responseDescribe.fields.bodyType) ?? throwErr('Response type must be defined and not mixed', { options, bodyTypeField: responseDescribe.fields.bodyType }),
          statusCodeDesc: undefinedIfMixed(responseDescribe.fields.statusCode) ?? throwErr('Status code must be defined and not mixed', { options, statusCodeField: responseDescribe.fields.statusCode }),
        };
      }),
    });
  }

  return result;
}

function getOpenApiType(field: yup.SchemaFieldDescription, type: string): string | [string, "null"] {
  assertResolvedSchemaDescription(field);
  // OpenAPI 3.1 uses JSON Schema type arrays instead of the removed OpenAPI 3.0 `nullable` keyword.
  return isFieldNullable(field) ? [type, "null"] : type;
}

function getFieldSchema(field: yup.SchemaFieldDescription, crudOperation?: Capitalize<CrudlOperation>): { type: string | [string, "null"], items?: any, properties?: any, required?: any, default?: any } | undefined {
  assertResolvedSchemaDescription(field);
  const meta = "meta" in field ? field.meta : {};
  if (meta?.openapiField?.hidden) {
    return undefined;
  }

  if (meta?.openapiField?.onlyShowInOperations && !meta.openapiField.onlyShowInOperations.includes(crudOperation as any)) {
    return undefined;
  }

  const openapiFieldExtra = {
    example: meta?.openapiField?.exampleValue,
    description: meta?.openapiField?.description,
    default: (field as any).default,
  };

  switch (field.type) {
    case 'string': {
      const oneOf = (field as any).oneOf as unknown[] | undefined;
      // yup.describe() often yields `oneOf: []` for unconstrained strings.
      // Treating that as an enum and appending null produces `"enum": [null]`,
      // which rejects every actual string (including optional `reason` notes).
      const constrainedOneOf = Array.isArray(oneOf)
        ? oneOf.filter((value) => value !== undefined)
        : [];
      const enumValues = constrainedOneOf.length === 0
        ? undefined
        : (isFieldNullable(field) && !constrainedOneOf.includes(null)
          ? [...constrainedOneOf, null]
          : constrainedOneOf);
      return {
        type: getOpenApiType(field, 'string'),
        ...enumValues && enumValues.length > 0 ? { enum: enumValues } : {},
        ...openapiFieldExtra,
      };
    }
    case 'number': {
      const tests = (field as any).tests as Array<{ name?: string }> | undefined;
      const isInteger = tests?.some(t => t.name === 'integer') ?? false;
      return { type: getOpenApiType(field, isInteger ? 'integer' : 'number'), ...openapiFieldExtra };
    }
    case 'boolean': {
      return { type: getOpenApiType(field, field.type), ...openapiFieldExtra };
    }
    case 'mixed': {
      return { type: getOpenApiType(field, 'object'), ...openapiFieldExtra };
    }
    case 'object': {
      return {
        type: getOpenApiType(field, 'object'),
        properties: typedFromEntries(typedEntries((field as any).fields)
          .map(([key, field]) => [key, getFieldSchema(field, crudOperation)])),
        required: typedEntries((field as any).fields)
          .filter(([_, field]) => !(field as any).optional && !isFieldNullable(field as any) && getFieldSchema(field as any, crudOperation))
          .map(([key]) => key),
        ...openapiFieldExtra
      };
    }
    case 'array': {
      return { type: getOpenApiType(field, 'array'), items: getFieldSchema((field as any).innerType, crudOperation), ...openapiFieldExtra };
    }
    case 'tuple': {
      // For OpenAPI, treat tuples as arrays since OpenAPI doesn't have native tuple support
      // This is commonly used for headers which are arrays of strings
      const tupleField = field as any;
      if (tupleField.innerType && tupleField.innerType.length > 0) {
        // Use the first element's schema as the array item type
        return { type: getOpenApiType(field, 'array'), items: getFieldSchema(tupleField.innerType[0], crudOperation), ...openapiFieldExtra };
      }
      // Fallback to string array if no inner type
      return { type: getOpenApiType(field, 'array'), items: { type: 'string' }, ...openapiFieldExtra };
    }
    default: {
      throw new Error(`Unsupported field type: ${field.type}`);
    }
  }
}

function toParameters(description: yup.SchemaFieldDescription, crudOperation?: Capitalize<CrudlOperation>, path?: string) {
  const pathParams: string[] = path ? path.match(/{[^}]+}/g) || [] : [];
  if (!isSchemaObjectDescription(description)) {
    throw new HexclaveAssertionError('Parameters field must be an object schema', { actual: description });
  }

  return Object.entries(description.fields).map(([key, field]) => {
    if (path && !pathParams.includes(`{${key}}`)) {
      return { schema: undefined };
    }

    const meta = "meta" in field ? field.meta : {};
    const schema = getFieldSchema(field, crudOperation);
    return {
      name: key,
      in: path ? 'path' : 'query',
      schema,
      description: meta?.openapiField?.description,
      required: !(field as any).optional && !!schema,
    };
  }).filter((x) => x.schema !== undefined);
}

function toHeaderParameters(description: yup.SchemaFieldDescription, crudOperation?: Capitalize<CrudlOperation>) {
  if (!isSchemaObjectDescription(description)) {
    throw new HexclaveAssertionError('Parameters field must be an object schema', { actual: description });
  }

  return Object.entries(description.fields).map(([key, tupleField]) => {
    if (!isSchemaTupleDescription(tupleField)) {
      throw new HexclaveAssertionError('Header field must be a tuple schema', { actual: tupleField, key });
    }
    if (tupleField.innerType.length !== 1) {
      throw new HexclaveAssertionError('Header fields of length !== 1 not currently supported', { actual: tupleField, key });
    }
    const field = tupleField.innerType[0];
    const meta = "meta" in field ? field.meta : {};
    const schema = getFieldSchema(field, crudOperation);
    return {
      name: key,
      in: 'header',
      schema,
      description: meta?.openapiField?.description,
      example: meta?.openapiField?.exampleValue,
      required: !(field as any).optional && !isFieldNullable(field) && !!schema,
    };
  }).filter((x) => x.schema !== undefined);
}

function toSchema(description: yup.SchemaFieldDescription, crudOperation?: Capitalize<CrudlOperation>): any {
  if (isSchemaObjectDescription(description)) {
    return {
      type: getOpenApiType(description, 'object'),
      properties: Object.fromEntries(Object.entries(description.fields).map(([key, field]) => {
        return [key, getFieldSchema(field, crudOperation)];
      }, {}))
    };
  } else if (isSchemaArrayDescription(description)) {
    return {
      type: getOpenApiType(description, 'array'),
      items: toSchema(description.innerType, crudOperation),
    };
  } else {
    throw new HexclaveAssertionError(`Unsupported schema type in toSchema: ${description.type}`, { actual: description });
  }
}

function toRequired(description: yup.SchemaFieldDescription, crudOperation?: Capitalize<CrudlOperation>) {
  let res: string[] = [];
  if (isSchemaObjectDescription(description)) {
    res = Object.entries(description.fields)
      .filter(([_, field]) => !(field as any).optional && !isFieldNullable(field) && getFieldSchema(field, crudOperation))
      .map(([key]) => key);
  } else if (isSchemaArrayDescription(description)) {
    res = [];
  } else {
    throw new HexclaveAssertionError(`Unsupported schema type in toRequired: ${description.type}`, { actual: description });
  }
  if (res.length === 0) return undefined;
  return res;
}

function toExamples(description: yup.SchemaFieldDescription, crudOperation?: Capitalize<CrudlOperation>) {
  if (!isSchemaObjectDescription(description)) {
    throw new HexclaveAssertionError('Examples field must be an object schema', { actual: description });
  }

  return Object.entries(description.fields).reduce((acc, [key, field]) => {
    const schema = getFieldSchema(field, crudOperation);
    if (!schema) return acc;
    const example = "meta" in field ? field.meta?.openapiField?.exampleValue : undefined;
    return { ...acc, [key]: example };
  }, {});
}

export function parseOverload(options: {
  metadata: EndpointDocumentation | undefined,
  method: string,
  path: string,
  pathDesc?: yup.SchemaFieldDescription,
  parameterDesc?: yup.SchemaFieldDescription,
  headerDesc?: yup.SchemaFieldDescription,
  requestBodyDesc?: yup.SchemaFieldDescription,
  responseVariants: Array<{
    responseDesc?: yup.SchemaFieldDescription,
    responseTypeDesc: yup.SchemaFieldDescription,
    statusCodeDesc: yup.SchemaFieldDescription,
  }>,
}) {
  const endpointDocumentation = options.metadata ?? {
    summary: `${options.method} ${options.path}`,
    description: `No documentation available for this endpoint.`,
  };
  if (endpointDocumentation.hidden) {
    return undefined;
  }

  const pathParameters = options.pathDesc ? toParameters(options.pathDesc, endpointDocumentation.crudOperation, options.path) : [];
  const queryParameters = options.parameterDesc ? toParameters(options.parameterDesc, endpointDocumentation.crudOperation) : [];
  const headerParameters = options.headerDesc ? toHeaderParameters(options.headerDesc, endpointDocumentation.crudOperation) : [];

  let requestBody;
  if (options.requestBodyDesc) {
    requestBody = {
      required: true,
      content: {
        'application/json': {
          schema: {
            ...toSchema(options.requestBodyDesc, endpointDocumentation.crudOperation),
            required: toRequired(options.requestBodyDesc, endpointDocumentation.crudOperation),
            example: toExamples(options.requestBodyDesc, endpointDocumentation.crudOperation),
          },
        },
      },
    };
  }

  const allResponses: Record<number, unknown> = {};

  for (const { responseDesc, responseTypeDesc, statusCodeDesc } of options.responseVariants) {
    if (!isSchemaStringDescription(responseTypeDesc)) {
      throw new HexclaveAssertionError(`Expected response type to be a string`, { actual: responseTypeDesc, options });
    }
    if (responseTypeDesc.oneOf.length !== 1) {
      throw new HexclaveAssertionError(`Expected response type to have exactly one value`, { actual: responseTypeDesc, options });
    }
    const bodyType = responseTypeDesc.oneOf[0];

    if (!isSchemaNumberDescription(statusCodeDesc)) {
      throw new HexclaveAssertionError('Expected status code to be a number', { actual: statusCodeDesc, options });
    }

    // Get all status codes or use 200 as default if none specified
    const statusCodes: number[] = statusCodeDesc.oneOf.length > 0
      ? statusCodeDesc.oneOf as number[]
      : [200]; // TODO HACK hardcoded, used in case all status codes may be returned, should be configurable per endpoint

    for (const status of statusCodes) {
      switch (bodyType) {
        case 'json': {
          allResponses[status] = {
            description: 'Successful response',
            content: {
              'application/json': {
                schema: {
                  ...responseDesc ? toSchema(responseDesc, endpointDocumentation.crudOperation) : {},
                  required: responseDesc ? toRequired(responseDesc, endpointDocumentation.crudOperation) : undefined,
                },
              },
            },
          };
          break;
        }
        case 'text': {
          if (!responseDesc || !isSchemaStringDescription(responseDesc)) {
            throw new HexclaveAssertionError('Expected response body of bodyType=="text" to be a string schema', { actual: responseDesc });
          }
          allResponses[status] = {
            description: 'Successful response',
            content: {
              'text/plain': {
                schema: {
                  type: 'string',
                  example: isSchemaStringDescription(responseDesc) ? responseDesc.meta?.openapiField?.exampleValue : undefined,
                },
              },
            },
          };
          break;
        }
        case 'success': {
          allResponses[status] = {
            description: 'Successful response',
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: {
                      type: "boolean",
                      description: "Always equal to true.",
                      example: true,
                    },
                  },
                  required: ["success"],
                },
              },
            },
          };
          break;
        }
        case 'empty': {
          allResponses[status] = {
            description: 'No content',
          };
          break;
        }
        default: {
          throw new HexclaveAssertionError(`Unsupported body type: ${bodyType}`);
        }
      }
    }
  }

  return {
    summary: endpointDocumentation.summary,
    description: endpointDocumentation.description,
    parameters: [...queryParameters, ...pathParameters, ...headerParameters],
    requestBody,
    tags: endpointDocumentation.tags ?? ["Others"],
    'x-full-url': `https://api.hexclave.com/api/v1${options.path}`,
    responses: allResponses,
  };
}

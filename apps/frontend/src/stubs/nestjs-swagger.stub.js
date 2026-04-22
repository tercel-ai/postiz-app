// Client-side stub for @nestjs/swagger.
// The Next.js frontend imports shared DTO classes from nestjs-libraries for
// validation only. The real @nestjs/swagger pulls in @nestjs/core (which
// requires Node built-ins like perf_hooks, async_hooks, repl and kafkajs),
// so we alias the package to these no-op decorators in the frontend bundle.

const noopDecorator = () => () => undefined;

export const ApiProperty = noopDecorator;
export const ApiPropertyOptional = noopDecorator;
export const ApiExtraModels = noopDecorator;
export const ApiTags = noopDecorator;
export const ApiOperation = noopDecorator;
export const ApiResponse = noopDecorator;
export const ApiOkResponse = noopDecorator;
export const ApiCreatedResponse = noopDecorator;
export const ApiBadRequestResponse = noopDecorator;
export const ApiUnauthorizedResponse = noopDecorator;
export const ApiForbiddenResponse = noopDecorator;
export const ApiNotFoundResponse = noopDecorator;
export const ApiInternalServerErrorResponse = noopDecorator;
export const ApiBody = noopDecorator;
export const ApiQuery = noopDecorator;
export const ApiParam = noopDecorator;
export const ApiHeader = noopDecorator;
export const ApiConsumes = noopDecorator;
export const ApiProduces = noopDecorator;
export const ApiBearerAuth = noopDecorator;
export const ApiBasicAuth = noopDecorator;
export const ApiCookieAuth = noopDecorator;
export const ApiSecurity = noopDecorator;
export const ApiHideProperty = noopDecorator;
export const ApiExcludeEndpoint = noopDecorator;
export const ApiExcludeController = noopDecorator;
export const ApiDefaultResponse = noopDecorator;

export const getSchemaPath = () => '';
export const refs = () => [];

export class DocumentBuilder {
  setTitle() { return this; }
  setDescription() { return this; }
  setVersion() { return this; }
  addTag() { return this; }
  addBearerAuth() { return this; }
  addBasicAuth() { return this; }
  addCookieAuth() { return this; }
  addSecurity() { return this; }
  addServer() { return this; }
  setContact() { return this; }
  setLicense() { return this; }
  setTermsOfService() { return this; }
  setExternalDoc() { return this; }
  build() { return {}; }
}

export const SwaggerModule = {
  createDocument: () => ({}),
  setup: () => undefined,
};

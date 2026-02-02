import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { INestApplication } from '@nestjs/common';

export const loadSwagger = (app: INestApplication) => {
  const config = new DocumentBuilder()
    .setTitle('Postiz Swagger file')
    .setDescription('API description')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Enter your JWT token',
      },
      'JWT-auth'
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  document.security = [{ 'JWT-auth': [] }];
  SwaggerModule.setup('docs', app, document);
};

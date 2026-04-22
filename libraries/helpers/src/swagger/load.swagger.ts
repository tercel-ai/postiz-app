import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { INestApplication } from '@nestjs/common';
import { GetPostsDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.dto';
import { GetPostsListDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts-list.dto';
import { CreatePostDto } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';
import { MediaDto } from '@gitroom/nestjs-libraries/dtos/media/media.dto';

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

  const document = SwaggerModule.createDocument(app, config, {
    extraModels: [GetPostsDto, GetPostsListDto, CreatePostDto, MediaDto],
  });
  document.security = [{ 'JWT-auth': [] }];
  SwaggerModule.setup('docs', app, document);

  app.getHttpAdapter().get('/openapi.json', (req: any, res: any) => {
    app.getHttpAdapter().reply(res, document, 200);
  });
};

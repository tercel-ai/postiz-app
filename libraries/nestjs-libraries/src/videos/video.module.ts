import { Global, Module } from '@nestjs/common';
import { ImagesSlides } from '@gitroom/nestjs-libraries/videos/images-slides/images.slides';
import { VideoManager } from '@gitroom/nestjs-libraries/videos/video.manager';
import { Veo3 } from '@gitroom/nestjs-libraries/videos/veo3/veo3';
import { Kling } from '@gitroom/nestjs-libraries/videos/kling/kling';

@Global()
@Module({
  providers: [ImagesSlides, Veo3, Kling, VideoManager],
  get exports() {
    return this.providers;
  },
})
export class VideoModule {}

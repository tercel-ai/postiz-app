import {
  BadRequestException,
  FileTypeValidator,
  Injectable,
  MaxFileSizeValidator,
  ParseFilePipe,
  PipeTransform,
} from '@nestjs/common';

/**
 * Shared with r2.uploader.ts's createMultipartUpload, which validates the
 * client-declared contentType the same way but has no Express.Multer.File to
 * hand this pipe — that flow issues a presigned URL before any bytes reach
 * this server, so a Multer-shaped file object never exists for it.
 */
export function isUploadableMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/') || mimeType.startsWith('video/mp4');
}

@Injectable()
export class CustomFileValidationPipe implements PipeTransform {
  async transform(value: any) {
    if (!value) {
      throw 'No file provided.';
    }

    if (!value.mimetype) {
      return value;
    }

    // Set the maximum file size based on the MIME type
    const maxSize = this.getMaxSize(value.mimetype);
    const validation =
      isUploadableMimeType(value.mimetype) && value.size <= maxSize;

    if (validation) {
      return value;
    }

    throw new BadRequestException(
      `File size exceeds the maximum allowed size of ${maxSize} bytes.`
    );
  }

  private getMaxSize(mimeType: string): number {
    if (mimeType.startsWith('image/')) {
      return 10 * 1024 * 1024; // 10 MB
    } else if (mimeType.startsWith('video/')) {
      return 1024 * 1024 * 1024; // 1 GB
    } else {
      throw new BadRequestException('Unsupported file type.');
    }
  }
}

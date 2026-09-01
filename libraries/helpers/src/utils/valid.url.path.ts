import {
  ValidationArguments,
  ValidatorConstraintInterface,
  ValidatorConstraint,
} from 'class-validator';

// The only file extensions MediaDto.path accepts. Exported because callers
// that BUILD a MediaDto (rather than receiving one over HTTP) need to check
// against the same list before handing it to a DTO-validated path — e.g.
// engage reference-media reuse re-hosts arbitrary third-party CDN files,
// whose content-type can yield an extension this rejects (avif, webm), and
// must drop those itself rather than let the whole request 400 downstream.
export const VALID_MEDIA_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.mp4',
] as const;

/** Whether `path` ends in a MediaDto-acceptable extension (query string ignored). */
export function hasValidMediaExtension(path: string): boolean {
  const withoutQuery = path?.split?.('?')?.[0];
  if (!withoutQuery) return false;
  return VALID_MEDIA_EXTENSIONS.some((ext) => withoutQuery.endsWith(ext));
}

@ValidatorConstraint({ name: 'checkValidExtension', async: false })
export class ValidUrlExtension implements ValidatorConstraintInterface {
  validate(text: string, args: ValidationArguments) {
    return hasValidMediaExtension(text);
  }

  defaultMessage(args: ValidationArguments) {
    // here you can provide default error message if validation failed
    return (
      'File must have a valid extension: .png, .jpg, .jpeg, .gif, .webp, or .mp4'
    );
  }
}

@ValidatorConstraint({ name: 'checkValidPath', async: false })
export class ValidUrlPath implements ValidatorConstraintInterface {
  validate(text: string, args: ValidationArguments) {
    if (!process.env.RESTRICT_UPLOAD_DOMAINS) {
      return true;
    }

    return (
      (text || 'invalid url').indexOf(process.env.RESTRICT_UPLOAD_DOMAINS) > -1
    );
  }

  defaultMessage(args: ValidationArguments) {
    // here you can provide default error message if validation failed
    return (
      'URL must contain the domain: ' + process.env.RESTRICT_UPLOAD_DOMAINS + ' Make sure you first use the upload API route.'
    );
  }
}

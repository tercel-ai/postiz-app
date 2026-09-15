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

/**
 * Whether `path` names a file MediaDto will accept.
 *
 * Normally that is the extension on the path itself, with the query string
 * ignored — `…/photo.jpg?name=large` is a jpg.
 *
 * Some CDNs put the format in the QUERY instead, and for those there is no
 * path extension to find. X's link-preview card images are the case this was
 * written for:
 *
 *   https://pbs.twimg.com/card_img/2099484736326418433/DnKAG7nW?format=jpg&name=orig
 *
 * That URL serves `image/jpeg` (verified live: HTTP 200, 53 KB) but its last
 * path segment is a bare hash, and there is no extension-bearing form of it to
 * rewrite to — `.jpg`, `.jpeg`, `:orig` and `/img.jpg` all 404 on that host,
 * only `?format=` works. Rejecting it made every X post whose only picture is
 * a link-preview card unusable, under an error that reads as "unsupported
 * format" for an ordinary JPEG.
 *
 * Reading the declared format is not a weaker check than reading the path.
 * Neither inspects bytes, and anyone who can name a file `x.jpg` can equally
 * append `?format=jpg`. What constrains WHERE media may come from is
 * ValidUrlPath / RESTRICT_UPLOAD_DOMAINS below, which is untouched.
 */
export function hasValidMediaExtension(path: string): boolean {
  const [withoutQuery, query] = (path ?? '').split('?');
  if (!withoutQuery) return false;
  if (VALID_MEDIA_EXTENSIONS.some((ext) => withoutQuery.endsWith(ext))) {
    return true;
  }
  if (!query) return false;
  // URLSearchParams rather than a regex: the format can sit anywhere in the
  // query (`?name=orig&format=jpg` is served just as happily as the other
  // order) and its value arrives percent-encoded.
  let format: string | null = null;
  try {
    format = new URLSearchParams(query).get('format');
  } catch {
    return false;
  }
  if (!format) return false;
  const declared = `.${format.trim().toLowerCase()}`;
  return VALID_MEDIA_EXTENSIONS.some((ext) => ext === declared);
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

import { BadRequestException, ValidationError } from '@nestjs/common';

/**
 * Drop-in `exceptionFactory` for Nest's global ValidationPipe.
 *
 * Mirrors the default message flattening ("posts.2.settings.subtitle must be
 * a string"), but labels errors under the `posts` array with identifying
 * fields taken from the offending element — post id (`value[0].id`),
 * integration id and platform — so a failing entry in a batch submit can be
 * located without counting array indices:
 *
 *   posts[2] (id=abc, platform=medium).settings.subtitle must be a string
 */
export function validationExceptionFactory(
  errors: ValidationError[]
): BadRequestException {
  const messages: string[] = [];
  collect(errors, '', messages);
  return new BadRequestException(messages);
}

function collect(
  errors: ValidationError[],
  parentPath: string,
  out: string[]
): void {
  for (const error of errors) {
    const path =
      parentPath === 'posts' && /^\d+$/.test(error.property)
        ? describePostElement(error.value, error.property)
        : parentPath
        ? `${parentPath}.${error.property}`
        : error.property;

    if (error.constraints) {
      // Constraint messages already start with the property name, so prefix
      // them with the path of the *containing* object, like Nest does.
      for (const message of Object.values(error.constraints)) {
        out.push(parentPath ? `${parentPath}.${message}` : message);
      }
    }

    if (error.children?.length) {
      collect(error.children, path, out);
    }
  }
}

function describePostElement(post: any, index: string): string {
  const parts: string[] = [];

  // On updates every content item carries the persisted Post row id; on
  // creates ids are server-generated later, so this may be absent.
  const postId = post?.value?.find?.((v: any) => v?.id)?.id;
  if (postId) parts.push(`id=${postId}`);

  if (post?.integration?.id) parts.push(`integration=${post.integration.id}`);

  const platform = post?.providerIdentifier || post?.settings?.__type;
  if (platform) parts.push(`platform=${platform}`);

  return parts.length
    ? `posts[${index}] (${parts.join(', ')})`
    : `posts[${index}]`;
}

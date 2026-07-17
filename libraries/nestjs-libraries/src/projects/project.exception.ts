import { HttpException, HttpStatus } from '@nestjs/common';

export type ProjectValidationErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_VALIDATION_UNAVAILABLE';

class ProjectValidationException extends HttpException {
  constructor(
    code: ProjectValidationErrorCode,
    status: HttpStatus,
    message: string
  ) {
    super({ code, message }, status);
  }
}

/**
 * Thrown for both "no such project" and "project belongs to another
 * organization" — always the same 404, so an unauthorized caller cannot
 * distinguish the two (project-scoped-post-engage-design.md §4/§8: never
 * leak cross-project existence).
 */
export class ProjectNotFoundException extends ProjectValidationException {
  constructor() {
    super('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND, 'Project not found');
  }
}

/** aisee-core could not be reached to validate ownership — fail closed. */
export class ProjectValidationUnavailableException extends ProjectValidationException {
  constructor() {
    super(
      'PROJECT_VALIDATION_UNAVAILABLE',
      HttpStatus.SERVICE_UNAVAILABLE,
      'Project validation temporarily unavailable'
    );
  }
}

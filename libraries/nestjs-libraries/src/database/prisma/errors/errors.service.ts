import { Injectable } from '@nestjs/common';
import { ErrorsRepository } from './errors.repository';

@Injectable()
export class ErrorsService {
  constructor(private _errorsRepository: ErrorsRepository) {}

  getById(id: string) {
    return this._errorsRepository.getById(id);
  }

  paginate(options: {
    page: number;
    pageSize: number;
    keyword?: string;
    organizationId?: string;
    platform?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }) {
    return this._errorsRepository.paginate(options);
  }
}

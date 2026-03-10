import { SetMetadata } from '@nestjs/common';

export const SUPER_ADMIN_KEY = 'require_super_admin';
export const SuperAdmin = () => SetMetadata(SUPER_ADMIN_KEY, true);

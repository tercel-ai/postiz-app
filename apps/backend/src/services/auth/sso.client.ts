import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';

interface SSOTokenResponse {
  success: boolean;
  access_data: {
    access_token: string;
    expires_at: number;
    token_type: string;
  };
  user: {
    id: string;
    email: string;
    username?: string;
  };
  message?: string;
}

@Injectable()
export class SsoClient {
  private readonly logger = new Logger(SsoClient.name);
  private readonly baseUrl = process.env.SSO_AUTH_URL;
  private readonly passwordSalt = process.env.SSO_AUTH_PASSWORD_SALT || '';

  private passwordWrap(value: string): string {
    if (this.passwordSalt === 'sha1') {
      return createHash('sha1').update(value).digest('hex');
    } else if (this.passwordSalt === 'md5') {
      return createHash('md5').update(value).digest('hex');
    }
    return value;
  }

  private getBaseUrl(): string {
    if (!this.baseUrl) {
      throw new Error('SSO_AUTH_URL is not configured');
    }
    return this.baseUrl;
  }

  async register(
    email: string,
    password: string,
    vcode: string,
    username?: string
  ): Promise<SSOTokenResponse> {
    const url = `${this.getBaseUrl()}/register`;
    this.logger.log(`Proxying registration to sso for email: ${email}`);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: this.passwordWrap(password), vcode, username }),
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      const detail = data.detail || data.message || 'Registration failed at sso';
      throw new Error(detail);
    }

    return data;
  }

  async login(email: string, password: string): Promise<SSOTokenResponse> {
    const url = `${this.getBaseUrl()}/login`;
    this.logger.log(`Proxying login to sso for email: ${email}`);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: this.passwordWrap(password) }),
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      const detail = data.detail || data.message || 'Login failed at sso';
      throw new Error(detail);
    }

    return data;
  }

  async refreshToken(refreshToken: string): Promise<SSOTokenResponse> {
    const url = `${this.getBaseUrl()}/token-refresh`;
    this.logger.log('Refreshing token via sso');

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      const detail = data.detail || data.message || 'Token refresh failed at sso';
      throw new Error(detail);
    }

    return data;
  }

  async logout(refreshToken: string): Promise<void> {
    const url = `${this.getBaseUrl()}/logout`;
    this.logger.log('Logging out via sso');

    try {
      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `refresh_token=${refreshToken}`,
        },
      });
    } catch (err) {
      this.logger.warn(`Logout call to sso failed: ${err}`);
    }
  }
}

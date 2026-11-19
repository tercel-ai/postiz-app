import { BadBody, SocialAbstract } from '../social.abstract';
import { PostDetails, SocialProvider } from './social.integrations.interface';

/** Browser-extension micro-posts; the server API route remains unavailable. */
export class ToutiaoProvider extends SocialAbstract implements SocialProvider {
  identifier = 'toutiao';
  name = 'Toutiao';
  isBetweenSteps = false;
  scopes: string[] = [];
  editor = 'normal' as const;
  // Disables the server write route; the browser extension sends micro-posts.
  extensionPublish = true;

  maxLength() { return 2000; }
  async generateAuthUrl() { return { url: '', codeVerifier: '', state: '' }; }
  async authenticate(): Promise<string> { return 'Connect this account through the browser extension'; }
  async refreshToken(): Promise<never> { throw new Error('Toutiao has no server-side credential'); }
  async post(_id: string, _token: string, posts: PostDetails[]): Promise<never> {
    throw new BadBody(this.identifier, '{}', JSON.stringify(posts?.[0] ?? {}), 'Toutiao publishing is not available');
  }
}

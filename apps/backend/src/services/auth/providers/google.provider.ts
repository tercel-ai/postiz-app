import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { OAuth2Client } from 'google-auth-library';
import { oauth2 } from 'googleapis/build/src/apis/oauth2';
import { ProvidersInterface } from '@gitroom/backend/services/auth/providers.interface';

const createOAuth2Client = () =>
  new OAuth2Client({
    clientId: process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    redirectUri: `${process.env.FRONTEND_URL}/integrations/social/youtube`,
  });

export class GoogleProvider implements ProvidersInterface {
  generateLink() {
    const state = makeId(7);
    const client = createOAuth2Client();
    return client.generateAuthUrl({
      access_type: 'online',
      prompt: 'consent',
      state,
      redirect_uri: `${process.env.FRONTEND_URL}/integrations/social/youtube`,
      scope: [
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
    });
  }

  async getToken(code: string) {
    const client = createOAuth2Client();
    const { tokens } = await client.getToken(code);
    return tokens.access_token;
  }

  async getUser(providerToken: string) {
    const client = createOAuth2Client();
    client.setCredentials({ access_token: providerToken });
    const user = oauth2({ version: 'v2', auth: client });
    const { data } = await user.userinfo.get();

    return {
      id: data.id!,
      email: data.email,
    };
  }
}

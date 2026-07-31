'use client';

import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';

// A Quora feed post is a single text body with no title or extra settings, so
// there is nothing to render beyond the editor. Publishing happens through the
// browser extension.
export default withProvider({
  postComment: PostComment.POST,
  minimumCharacters: [],
  SettingsComponent: null,
  CustomPreviewComponent: undefined,
  dto: undefined,
  checkValidity: async () => {
    return true;
  },
  maximumCharacters: 20000,
});

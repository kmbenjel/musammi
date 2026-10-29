// The ephemeral Gemini Live token. The whole session setup (LIVE_CONFIG for the chosen riwaya: prompt, tools, manual
// turns, transcription) and the resumption handle are locked into it; the client's own setup message is ignored.
// One function for both ways in, so the setup cannot drift between them:
// - the Worker mints it with the owner's key (/api/live/token, behind ACCESS_KEY);
// - the browser mints it with the reciter's own AI Studio key, which never leaves the device except to Google
//   (Google's token endpoint accepts calls from the browser). Loaded on demand: the SDK is only needed there.
import { GoogleGenAI } from '@google/genai';
import { liveConfig } from './prompt';

export const LIVE_MODEL = 'gemini-3.8-live';

export async function mintToken(apiKey: string, opts: { riwaya?: string | null; handle?: string | null; model?: string }) {
  const model = 'models/' + (opts.model || LIVE_MODEL);
  const client = new GoogleGenAI({ apiKey, apiVersion: 'v1alpha' });
  const now = Date.now();
  const t = await client.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
      newSessionExpireTime: new Date(now + 2 * 60 * 1000).toISOString(),
      liveConnectConstraints: {
        model,
        config: { ...(liveConfig(opts.riwaya) as object), sessionResumption: opts.handle ? { handle: opts.handle } : {} },
      },
    },
  });
  return { token: t.name as string, model };
}

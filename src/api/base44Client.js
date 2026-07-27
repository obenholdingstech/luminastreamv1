import { createClient } from '@base44/sdk';
import { appParams } from '@/lib/app-params';
import { API_BASE } from '@/lib/apiBase';

const { appId, token, functionsVersion, appBaseUrl } = appParams;

//Create a client with authentication required
export const base44 = createClient({
  appId,
  token,
  functionsVersion,
  serverUrl: API_BASE,
  requiresAuth: false,
  appBaseUrl
});

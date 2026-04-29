# OpenCode mTLS Proxy

Local OpenAI-compatible reverse proxy for connecting OpenCode to an OpenAI-style LLM provider that requires mTLS client certificates.

## Requirements

- Node.js 20 or newer
- Client certificate file
- Client private key file
- CA certificate file only if the endpoint uses a private CA

## Install

```bash
npm install
npm run build
```

## Run

You can configure the proxy with a local `.env` file:

```bash
UPSTREAM_BASE_URL=https://llm-provider.example.com
CLIENT_CERT_PATH=/absolute/path/client.crt
CLIENT_KEY_PATH=/absolute/path/client.key
LOCAL_AUTH_TOKEN=local-opencode-token
```

Then start the proxy:

```bash
npm start
```

Shell environment variables still work. If a key is set in both places, the `.env` value wins.

Set `UPSTREAM_BASE_URL` to the provider origin or path prefix before the OpenAI-compatible path that OpenCode sends. For example, if OpenCode uses local base URL `http://127.0.0.1:8787/v1`, use `https://llm-provider.example.com` or `https://llm-provider.example.com/openai`, not `https://llm-provider.example.com/v1`.

If the endpoint uses a private CA, also set:

```bash
CA_CERT_PATH=/absolute/path/ca.crt
```

Defaults:

- `LISTEN_HOST=127.0.0.1`
- `LISTEN_PORT=8787`
- `FORWARD_AUTHORIZATION=false`
- `UPSTREAM_TIMEOUT_MS=120000`

## OpenCode Configuration

Configure OpenCode with a custom OpenAI-compatible provider that points at the local proxy. Add this to your global `~/.config/opencode/opencode.json` or to a project-local `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "mtls-proxy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "mTLS Proxy",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "local-opencode-token"
      },
      "models": {
        "MODEL_NAME": {
          "name": "MODEL_NAME"
        }
      }
    }
  },
  "model": "mtls-proxy/MODEL_NAME"
}
```

Replace `MODEL_NAME` with a model supported by the upstream provider. The `apiKey` must match `LOCAL_AUTH_TOKEN` if the proxy is configured with one; otherwise use any non-empty dummy value accepted by OpenCode.

You can also keep the token in an environment variable:

```json
"apiKey": "{env:OPENCODE_MTLS_PROXY_API_KEY}"
```

Then export it before starting OpenCode:

```bash
export OPENCODE_MTLS_PROXY_API_KEY=local-opencode-token
```

The proxy's `.env` file is only read by this proxy process, not by OpenCode. Start the proxy first with `npm start`, then start OpenCode and select the configured model:

```bash
opencode --model mtls-proxy/MODEL_NAME
```

Required values:

- Base URL: `http://127.0.0.1:8787/v1`
- API key: `local-opencode-token` if `LOCAL_AUTH_TOKEN` is set, otherwise any non-empty dummy value accepted by OpenCode
- Model: a model name supported by the provider

## Verify Direct Upstream mTLS

These direct upstream checks use shell-expanded variables. Export the values first if you keep configuration only in `.env`.

```bash
curl --cert "$CLIENT_CERT_PATH" --key "$CLIENT_KEY_PATH" \
  "$UPSTREAM_BASE_URL/v1/models"
```

Expected: JSON model response from the provider.

If the endpoint uses a private CA, add `--cacert "$CA_CERT_PATH"`:

```bash
curl --cert "$CLIENT_CERT_PATH" --key "$CLIENT_KEY_PATH" --cacert "$CA_CERT_PATH" \
  "$UPSTREAM_BASE_URL/v1/models"
```

## Verify Local Proxy

```bash
curl -H "Authorization: Bearer local-opencode-token" \
  "http://127.0.0.1:8787/v1/models"
```

Expected: JSON model response through the local proxy.

## Verify Chat Completion

```bash
curl -H "Authorization: Bearer local-opencode-token" \
  -H 'Content-Type: application/json' \
  -d '{"model":"MODEL_NAME","messages":[{"role":"user","content":"ping"}],"max_tokens":16}' \
  "http://127.0.0.1:8787/v1/chat/completions"
```

Expected: OpenAI-compatible chat completion response.

## Security Notes

- The proxy binds to `127.0.0.1` by default.
- The proxy does not forward OpenCode's local `Authorization` header upstream unless `FORWARD_AUTHORIZATION=true`.
- Normal logs include request metadata only.
- Do not commit real certificate, key, CA, or `.env` files.

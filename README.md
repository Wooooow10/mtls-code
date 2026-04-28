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

```bash
export UPSTREAM_BASE_URL='https://llm-provider.example.com'
export CLIENT_CERT_PATH='/absolute/path/client.crt'
export CLIENT_KEY_PATH='/absolute/path/client.key'
export LOCAL_AUTH_TOKEN='local-opencode-token'

npm start
```

Set `UPSTREAM_BASE_URL` to the provider origin or path prefix before the OpenAI-compatible path that OpenCode sends. For example, if OpenCode uses local base URL `http://127.0.0.1:8787/v1`, use `https://llm-provider.example.com` or `https://llm-provider.example.com/openai`, not `https://llm-provider.example.com/v1`.

If the endpoint uses a private CA, also set:

```bash
export CA_CERT_PATH='/absolute/path/ca.crt'
```

Defaults:

- `LISTEN_HOST=127.0.0.1`
- `LISTEN_PORT=8787`
- `FORWARD_AUTHORIZATION=false`
- `UPSTREAM_TIMEOUT_MS=120000`

## OpenCode Configuration

Configure OpenCode as an OpenAI-compatible provider:

- Base URL: `http://127.0.0.1:8787/v1`
- API key: `local-opencode-token` if `LOCAL_AUTH_TOKEN` is set, otherwise any non-empty dummy value accepted by OpenCode
- Model: a model name supported by the provider

## Verify Direct Upstream mTLS

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
curl -H "Authorization: Bearer $LOCAL_AUTH_TOKEN" \
  "http://127.0.0.1:8787/v1/models"
```

Expected: JSON model response through the local proxy.

## Verify Chat Completion

```bash
curl -H "Authorization: Bearer $LOCAL_AUTH_TOKEN" \
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

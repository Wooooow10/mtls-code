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
- `TRANSLATION_MODE=passthrough`
- `UPSTREAM_TLS_VERIFY=true`
- `UPSTREAM_TIMEOUT_MS=120000`

If the upstream server presents a certificate that Node cannot verify and you cannot provide the correct CA bundle, you can temporarily disable upstream server certificate verification:

```bash
UPSTREAM_TLS_VERIFY=false
```

Use this only as a diagnostic or last-resort workaround. It disables verification of the upstream server certificate; it does not disable sending the configured client certificate and key.

## OpenAI ↔ GigaChat Translation Mode

By default the proxy remains a pass-through proxy. To opt in to OpenAI-compatible request/response translation for the raw GigaChat HTTP API, set:

```bash
TRANSLATION_MODE=openai-gigachat
```

MVP translated endpoints:

- `POST /chat/completions` and `POST /v1/chat/completions`
- `GET /models` and `GET /v1/models`
- `GET /models/:model` and `GET /v1/models/:model`

In this mode chat requests are sent upstream as GigaChat `/chat/completions` JSON, including tool/function conversion, `response_format.type=json_schema` conversion through a synthetic GigaChat function, and streaming SSE conversion back to OpenAI chat chunks. The translator requests `Accept-Encoding: identity` from upstream and rewrites translated response representation headers. Model list/detail responses are normalized to OpenAI-compatible model objects. Unsupported endpoints return an OpenAI-style error without calling upstream.

`tool_choice` is converted when it names a specific function. String choices `auto` and `required` are removed while leaving converted functions available; `none` is removed and converted functions are not forwarded.

For raw HTTP compatibility, streaming chat requests that include converted GigaChat `functions` or a forced `function_call` are sent upstream as non-streaming requests and converted back to OpenAI SSE downstream. This avoids raw streaming responses that finish with function-call semantics but omit usable tool-call payloads.

For MVP safety, translated request bodies, non-streaming upstream response bodies, and individual upstream SSE events are each buffered up to 1 MiB. Larger translated requests return `413`; larger upstream buffers return safe `502` errors.

If a translated non-streaming chat or models response cannot be parsed as JSON, the OpenAI-style error includes safe upstream diagnostics under `error.upstream`: HTTP status, content type, body byte length, and a short sanitized body preview when text-like. Non-JSON upstream error statuses such as `401` or `429` are preserved instead of being rewritten to `502`.

Deferred from this MVP: Responses API, embeddings, files, batches, and image/file attachment uploads in chat messages.

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

If direct `curl` works only with `-k` or `--insecure`, fix `CA_CERT_PATH` when possible. `UPSTREAM_TLS_VERIFY=false` gives the proxy the same insecure behavior as `curl -k`.

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
- Keep `UPSTREAM_TLS_VERIFY=true` in normal use. Setting it to `false` makes the proxy trust any upstream certificate.
- The proxy does not forward OpenCode's local `Authorization` header upstream unless `FORWARD_AUTHORIZATION=true`.
- Normal logs include request metadata only.
- Do not commit real certificate, key, CA, or `.env` files.

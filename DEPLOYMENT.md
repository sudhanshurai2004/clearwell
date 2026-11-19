# Clearwell deployment

Clearwell can be deployed on Render using the included `render.yaml` blueprint.

## Required provider setup

The only external setup required is a free Render account. No secret value should be sent in chat or committed to Git.

Render generates:
- API key hashing secret
- JWT secret
- PSP callback signing secret
- webhook signing secret

Render also provisions PostgreSQL and injects `DATABASE_URL`.

## Deploy

1. Sign in to Render.
2. Open **Blueprints** and select **New Blueprint**.
3. Connect `https://github.com/sudhanshurai2004/clearwell`.
4. Apply the blueprint.
5. Wait for migrations and the API health check.

## Generated endpoints

After deployment, Render provides a public HTTPS URL:
- `https://<service>.onrender.com`
- `/health`
- `/ready`
- `/metrics`
- `/` (React dashboard)

## Free-tier limits

Free web services can sleep after inactivity and may take time to start again. Free database availability and retention limits vary by provider and region. The PSP remains a simulator and must not be used for real funds.

## Production secrets

Set these as Render environment variables:
- `DATABASE_URL`
- `API_KEY_HASH_SECRET`
- `JWT_SECRET`
- `PSP_CALLBACK_SECRET`
- `WEBHOOK_SIGNING_SECRET`

Do not commit `.env` or real credentials to GitHub.

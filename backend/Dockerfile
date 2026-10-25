# Build context is the repository root (see docker-compose.yml):
#   (from backend/)  docker build -f Dockerfile -t wind-forecast-monitor ..
# --- 1. build the React app -------------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# --- 2. Python API that also serves the built app ---------------------------------
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8000
WORKDIR /app
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./app
COPY backend/data ./data
COPY --from=web /web/dist ./static
RUN useradd --create-home appuser
USER appuser
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://localhost:{os.environ[\"PORT\"]}/api/health')"
# PORT can be overridden at runtime; defaults to 8000.
# --proxy-headers trusts X-Forwarded-* only from FORWARDED_ALLOW_IPS (default 127.0.0.1),
# so https:// is detected correctly behind a TLS-terminating proxy without trusting clients.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers"]

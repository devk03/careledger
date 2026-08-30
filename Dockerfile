# syntax=docker/dockerfile:1.7
FROM node:22.23.2-alpine AS web-builder
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM python:3.12.10-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/app/.venv/bin:$PATH \
    APP_ENVIRONMENT=production \
    DATA_DIR=/data \
    APP_PORT=8080

RUN groupadd --system --gid 10001 careledger \
    && useradd --system --uid 10001 --gid careledger --home-dir /app careledger

WORKDIR /app
COPY pyproject.toml uv.lock README.md LICENSE ./
COPY app ./app
RUN pip install --no-cache-dir uv==0.6.16
RUN uv sync --frozen --no-dev --no-editable --no-cache
COPY --from=web-builder /build/web/dist ./web/dist

RUN mkdir -p /data && chown -R careledger:careledger /data /app
USER careledger
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=20s --timeout=3s --start-period=15s --retries=3 \
  CMD ["python", "-c", "import os,urllib.request; p=os.getenv('PORT',os.getenv('APP_PORT','8080')); urllib.request.urlopen('http://127.0.0.1:'+p+'/health/ready',timeout=2)"]
CMD ["python", "-m", "app.run"]

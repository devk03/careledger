# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM node:22.23.2-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS web-builder
ARG ADENO_RELEASE_SHA
ARG ADENO_RELEASE_BUILD=0
ENV VITE_ADENO_RELEASE_SHA=${ADENO_RELEASE_SHA}
ENV ADENO_RELEASE_BUILD=${ADENO_RELEASE_BUILD}
WORKDIR /build
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/contracts/tsconfig.json ./packages/contracts/tsconfig.json
COPY packages/contracts/src/ ./packages/contracts/src/
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tools/reviewedPublicAssets.mjs tools/verifyPublicAssets.mjs tools/validateReleaseSha.mjs /build/tools/
COPY web/ ./
RUN node /build/tools/validateReleaseSha.mjs
RUN node /build/tools/verifyPublicAssets.mjs
RUN npm run build
RUN test -s dist/images/garden-1200.webp \
    && test -s dist/images/garden-640.webp \
    && test -s dist/images/notes-1200.webp \
    && test -s dist/images/notes-1536.webp \
    && test -s dist/images/notes-640.webp

FROM python:3.12.10-slim@sha256:fd95fa221297a88e1cf49c55ec1828edd7c5a428187e67b5d1805692d11588db AS runtime
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
HEALTHCHECK --interval=20s --timeout=3s --start-period=15s --retries=3 \
  CMD ["python", "-c", "import os,urllib.request; p=os.getenv('PORT',os.getenv('APP_PORT','8080')); urllib.request.urlopen('http://127.0.0.1:'+p+'/health/ready',timeout=2)"]
CMD ["python", "-m", "app.run"]

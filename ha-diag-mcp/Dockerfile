ARG BUILD_FROM
FROM $BUILD_FROM

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apk add --no-cache nodejs npm

WORKDIR /app

# Copy server package manifests first for better caching
COPY server/ /app/server/
WORKDIR /app/server

RUN npm ci --include=dev \
  && npm run build \
  && test -f dist/index.js \
  && npm prune --omit=dev

# Add-on runner
COPY run.sh /run.sh
RUN chmod a+x /run.sh

WORKDIR /app
CMD [ "/run.sh" ]
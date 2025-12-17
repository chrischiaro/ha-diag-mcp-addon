ARG BUILD_FROM
FROM $BUILD_FROM

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apk add --no-cache nodejs npm

WORKDIR /app

# Copy server package manifests first for better caching
COPY server/package.json /app/server/package.json
COPY server/tsconfig.json /app/server/tsconfig.json

WORKDIR /app/server
RUN npm install --omit=dev

# Copy the server source and build it
COPY server/src /app/server/src

RUN npm install --include=dev \
  && npm run build \
  && npm prune --omit=dev

# Add-on runner
COPY run.sh /run.sh
RUN chmod a+x /run.sh

WORKDIR /app
CMD [ "/run.sh" ]
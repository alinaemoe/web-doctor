# Web Doctor public server: one container, SQLite on a volume.
# Build:  docker build -t webdoctor .
# Run:    see docker-compose.yml and docs/deploy.md
FROM mcr.microsoft.com/playwright:v1.64.0-noble

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NODE_ENV=production \
    HOME=/tmp
RUN npm install --global pnpm@12.11.2

WORKDIR /app
COPY . .
# devDependencies are needed: the CLI runs through tsx and the UI is built here
RUN NODE_ENV=development pnpm install --frozen-lockfile \
 && pnpm --filter @webdoctor/web build \
 && mkdir -p /data && chown -R pwuser:pwuser /data

USER pwuser
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["node", "--import", "tsx", "apps/cli/src/main.ts"]
CMD ["serve", "--host", "0.0.0.0", "--port", "8080", "--dir", "/data"]

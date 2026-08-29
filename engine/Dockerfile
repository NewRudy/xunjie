FROM node:24-bookworm-slim
WORKDIR /app

RUN npm config set registry https://registry.npmmirror.com \
 && npm install -g pnpm@9

COPY package.json pnpm-lock.yaml ./
COPY src ./src
RUN pnpm install --frozen-lockfile

ENV PORT=8787
EXPOSE 8787
CMD ["pnpm", "start"]

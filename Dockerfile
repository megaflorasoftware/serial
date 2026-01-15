FROM node:22.12.0-slim AS build
WORKDIR /src

COPY package.json package-lock.json ./
RUN pnpm ci

COPY . .
RUN pnpm run build

FROM node:22.12.0-slim AS run
WORKDIR /src
ENV NODE_ENV=production
COPY --from=build /src ./

EXPOSE 3000
CMD ["pnpm", "start"]

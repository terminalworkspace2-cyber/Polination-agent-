FROM oven/bun:1
WORKDIR /app
COPY package.json server.ts ./
ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000
CMD ["bun", "run", "server.ts"]

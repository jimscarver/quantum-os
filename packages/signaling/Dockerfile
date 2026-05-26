FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY package.json ./
RUN npm install --omit=dev
EXPOSE 4444
ENV PORT=4444
CMD ["node", "dist/index.js"]

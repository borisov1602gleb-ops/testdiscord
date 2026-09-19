FROM node:20-alpine

# Контекст сборки — корень репозитория: образ отдаёт и API, и статику клиента.
WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev

COPY backend/src ./src
COPY frontend /app/frontend

EXPOSE 3000
CMD ["node", "src/index.js"]

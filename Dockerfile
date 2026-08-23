# Stage 1: build
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: serve with nginx (tiny image)
FROM nginx:alpine AS runner
# Fix MIME for .mjs worker - nginx alpine default lacks mjs
RUN sed -i 's|application/javascript *js;|application/javascript js mjs;|' /etc/nginx/mime.types \
 && grep -q "mjs" /etc/nginx/mime.types || sed -i '/types {/a \    application/javascript mjs;' /etc/nginx/mime.types \
 && cat /etc/nginx/mime.types | grep -i javascript
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

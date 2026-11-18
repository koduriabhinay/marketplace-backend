# The website image: build the React app with Node, then serve the static files from Nginx.
# Node isn't in the final image at all: it's ~50 MB of Nginx plus a few hundred KB of site.

# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime stage: Nginx (TLS, load balancing, gateway) + the built site ----
FROM nginx:1.29-alpine
COPY --from=build /web/dist /usr/share/nginx/html

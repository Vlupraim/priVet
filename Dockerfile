FROM nginx:1.27-alpine

ENV API_BASE_URL=https://whisper-skynet.bourbaki-lab.duckdns.org

COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY docker/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh

COPY index.html /usr/share/nginx/html/index.html
COPY assets /usr/share/nginx/html/assets

RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh

EXPOSE 80

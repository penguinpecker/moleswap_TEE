FROM node:18-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY src/ ./src/
ENV IEXEC_IN=/iexec_in
ENV IEXEC_OUT=/iexec_out
RUN mkdir -p /iexec_out
RUN addgroup -S iexec && adduser -S iexec -G iexec
USER iexec
ENTRYPOINT ["node", "src/app.js"]

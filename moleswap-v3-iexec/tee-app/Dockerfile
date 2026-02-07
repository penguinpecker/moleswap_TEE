# MoleSwap TEE Matching Engine
# Runs inside iExec SGX enclave (SCONE)

FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install --production

# Copy application source
COPY src/ ./src/

# iExec TEE standard environment variables
ENV IEXEC_IN=/iexec_in
ENV IEXEC_OUT=/iexec_out

# Create output directory
RUN mkdir -p /iexec_out

# Non-root execution (security)
RUN addgroup -S iexec && adduser -S iexec -G iexec
USER iexec

# Entrypoint
ENTRYPOINT ["node", "src/app.js"]

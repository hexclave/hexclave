FROM node:24-alpine

WORKDIR /app

# Install PostgreSQL client for pg_recvlogical
RUN apk add --no-cache postgresql-client

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 8080

CMD ["npm", "start"]

FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy application source code
COPY . .

# Build typescript
RUN npm run build

EXPOSE 4000 4001

CMD ["npm", "start"]

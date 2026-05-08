# 1. Start with a lightweight version of Node.js
FROM node:20-alpine

# 2. Tell Docker to create a working directory inside the container called '/app'
WORKDIR /app

# 3. Copy only the package files first (this makes future builds faster)
COPY package*.json ./

# 4. Install all the dependencies
RUN npm install

# 5. Copy the rest of your server code into the container
COPY . .

# 6. Compile the TypeScript code into plain JavaScript
RUN npx tsc

# 7. Expose port 3000 so the outside world can talk to our server
EXPOSE 3000

# 8. Run the compiled JavaScript file
CMD ["node", "dist/server.js"]

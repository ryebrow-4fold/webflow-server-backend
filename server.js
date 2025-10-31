// This imports the express framework so we can use it.
const express = require('express');

// This creates our server application.
const app = express();

// This is the "server endpoint" that Webflow will talk to.
// It's set up to handle a POST request.
app.post('/api/create-checkout-session', (request, response) => {
  // Log the data you receive from Webflow to the terminal.
  console.log(request.body);

  // Send a confirmation back to Webflow.
  response.send('Received your data!');
});

// This tells our server to start listening for requests on port 3000.
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running and listening on port ${port}`);
});
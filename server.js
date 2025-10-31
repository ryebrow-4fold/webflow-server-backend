// Import the express and stripe modules
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); // Replace with your actual secret key if not using environment variables

const app = express();
const port = process.env.PORT || 3000;

// IMPORTANT: We need the raw body of the request to verify the Stripe signature.
// This middleware is specifically for the webhook endpoint.
app.post('/api/create-checkout-session', express.raw({ type: 'application/json' }), (request, response) => {
  const sig = request.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET; // Uses the environment variable you set on Render

  let event;

  try {
    // This is the key step: verify the event came from Stripe using your secret.
    event = stripe.webhooks.constructEvent(request.body, sig, webhookSecret);
  } catch (err) {
    // If the signature is invalid, we send an error back to Stripe.
    console.log(`Webhook signature verification failed: ${err.message}`);
    return response.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the specific event type that Stripe sent
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      console.log('--- Checkout session completed! ---');
      console.log('Customer Email:', session.customer_email);
      // ** Add your custom logic here **
      // e.g., Fulfill the order, send a confirmation email, update your CMS, etc.
      break;
    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      console.log('--- Payment intent succeeded! ---');
      // ** Add custom logic here **
      break;
    // ... handle other event types as needed
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  // Return a 200 response to acknowledge receipt of the event
  response.send();
});

// For all other routes/endpoints, you can use standard JSON parsing middleware
app.use(express.json());

// Start the server
app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});
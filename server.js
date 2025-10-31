// Load environment variables
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL
}));
app.use(express.json({ limit: '10mb' }));

// Health check endpoint (test your server is running)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Rock Creek Granite API is running' });
});

// Create Stripe checkout session
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { config, pricing, encodedConfig } = req.body;

    console.log('📦 Creating checkout session for:', {
      shape: config.shape,
      color: config.color,
      total: pricing.total
    });

    // Build description for Stripe
    let description = `${config.shape.toUpperCase()} countertop`;
    if (config.shape === 'rectangle') {
      description += ` - ${config.dims.L}" × ${config.dims.W}"`;
    } else if (config.shape === 'circle') {
      description += ` - ${config.dims.D}" diameter`;
    } else {
      description += ` - ${config.dims.n} sides`;
    }
    description += ` | DEKTON ${config.color} | Ship to: ${config.zip}`;

    // Create the Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Custom DEKTON Countertop',
              description: description,
              images: ['https://rockcreekgranite.com/path-to-logo.jpg'], // Optional: add your logo
            },
            unit_amount: Math.round(pricing.total * 100), // Convert to cents
          },
          quantity: 1,
        },
      ],
      success_url: `${process.env.FRONTEND_URL}/order-confirmation?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/config-checkout?cfg=${encodedConfig}`,
      
      // Store configuration for webhook
      metadata: {
        config: JSON.stringify(config),
        pricing: JSON.stringify(pricing)
      },
      
      // Collect shipping info
      shipping_address_collection: {
        allowed_countries: ['US'],
      },
      
      // Customer email
      customer_email: req.body.email || undefined,
    });

    console.log('✅ Checkout session created:', session.id);

    res.json({ 
      sessionId: session.id,
      url: session.url
    });

  } catch (error) {
    console.error('❌ Error creating checkout session:', error);
    res.status(500).json({ 
      error: error.message 
    });
  }
});

// Webhook endpoint (Stripe will call this when payment succeeds)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  
  let event;
  try {
    // Verify the webhook came from Stripe
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('⚠️  Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    
    console.log('🎉 Payment successful!');
    console.log('Customer:', session.customer_details.email);
    console.log('Amount:', session.amount_total / 100);
    
    // Parse the configuration
    const config = JSON.parse(session.metadata.config);
    const pricing = JSON.parse(session.metadata.pricing);
    
    console.log('📋 Order details:', {
      shape: config.shape,
      dims: config.dims,
      color: config.color,
      sinks: config.sinks.length
    });

    // TODO: 
    // 1. Generate DXF file
    // 2. Email customer confirmation
    // 3. Email your shop the production order
    // 4. Save to your database/spreadsheet
    
    // For now, just log it
    console.log('✅ Order ready for processing');
  }

  res.json({ received: true });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
});
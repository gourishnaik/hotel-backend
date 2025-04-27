const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const schedule = require('node-schedule');
const twilio = require('twilio');

const moment = require('moment-timezone'); // Install via: npm install moment-timezone
// Load environment variables
dotenv.config();

// Initialize Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// MongoDB Connection with retry logic
const connectWithRetry = async () => {
  const MONGODB_URI = process.env.MONGODB_URI || 'your-default-mongo-uri';
  
  try {
    await mongoose.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      family: 4
    });
    console.log('Connected to MongoDB Atlas');
    console.log('MongoDB URI:', MONGODB_URI.replace(/\/\/[^:]+:[^@]+@/, '//<credentials>@'));
  } catch (err) {
    console.error('MongoDB connection error:', err);
    console.error('MongoDB URI:', MONGODB_URI.replace(/\/\/[^:]+:[^@]+@/, '//<credentials>@'));
    console.log('Retrying connection in 5 seconds...');
    setTimeout(connectWithRetry, 5000);
  }
};

// Initial connection attempt
connectWithRetry();

// Order Schema
const orderSchema = new mongoose.Schema({
  orderId: { type: Number, required: true },
  items: [{
    menuItem: {
      id: Number,
      name: String,
      description: String,
      price: Number,
      category: String
    },
    quantity: Number,
    subtotal: Number
  }],
  total: Number,
  date: { type: Date, default: Date.now },
  status: { type: String, enum: ['pending', 'completed', 'cancelled'], default: 'pending' },
  tableNumber: Number,
  customerName: String
});

const Order = mongoose.model('Order', orderSchema);

// Routes
// app.post('/api/orders', async (req, res) => {
//   console.log('Received POST request to /api/orders');
//   try {
//     const orderData = req.body;
//     if (orderData.id) {
//       orderData.orderId = orderData.id;
//       delete orderData.id;
//     }
//     const order = new Order(orderData);
//     await order.save();
//     res.status(201).json(order);
//   } catch (error) {
//     console.error('Error saving order:', error);
//     res.status(400).json({ message: error.message });
//   }
// });

app.post('/api/orders', async (req, res) => {
  console.log('Received POST request to /api/orders');
  try {
    const orderData = req.body;

    if (orderData.id) {
      orderData.orderId = orderData.id;
      delete orderData.id;
    }

    // Always set order as 'completed' unless specified
    if (!orderData.status) {
      orderData.status = 'completed'; // Default to completed
    }

    // Ensure date is correct
    if (!orderData.date) {
      orderData.date = new Date();
    }

    const order = new Order(orderData);
    await order.save();
    res.status(201).json(order);
  } catch (error) {
    console.error('Error saving order:', error);
    res.status(400).json({ message: error.message });
  }
});

app.get('/api/orders', async (req, res) => {
  console.log('Received GET request to /api/orders');
  try {
    const orders = await Order.find();
    res.json(orders);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/orders/completed', async (req, res) => {
  console.log('Received GET request to /api/orders/completed');
  try {
    const orders = await Order.find({ status: 'completed' });
    console.log(`Found ${orders.length} completed orders`);
    res.json(orders);
  } catch (error) {
    console.error('Error fetching completed orders:', error);
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/orders/total', async (req, res) => {
  console.log('Received GET request to /api/orders/total');
  try {
    const total = await Order.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, totalAmount: { $sum: '$total' } } }
    ]);
    
    res.json({
      totalAmount: total.length > 0 ? total[0].totalAmount : 0,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error calculating total amount:', error);
    res.status(500).json({ message: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  console.log('Health check requested');
  const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  res.status(200).json({ 
    status: 'ok',
    database: dbStatus,
    timestamp: new Date().toISOString()
  });
});

// Calculate daily total
const calculateDailyTotal = async () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const orders = await Order.find({
    date: {
      $gte: today,
      $lt: tomorrow
    },
    status: 'completed'
  });

  const total = orders.reduce((sum, order) => sum + order.total, 0);
  return total;
};

// Function to send SMS
const sendSMS = async (message) => {
  try {
    await twilioClient.messages.create({
      body: message,
      to: process.env.ADMIN_PHONE_NUMBER,
      from: process.env.TWILIO_PHONE_NUMBER
    });
    console.log('SMS sent successfully');
  } catch (error) {
    console.error('Error sending SMS:', error);
  }
};

// Schedule SMS notification at 11 PM IST (17:30 UTC)
schedule.scheduleJob('30 17 * * *', async () => {
  console.log('Sending daily total SMS notification at 11PM IST...');
  const dailyTotal = await calculateDailyTotal();
  const message = `Daily Total for ${new Date().toLocaleDateString()}: ₹${dailyTotal.toFixed(2)}`;
  await sendSMS(message);
});

// Schedule data clearing at 12 AM IST (18:30 UTC)
// Schedule data clearing at 12:00 AM IST
// Schedule daily clearing
schedule.scheduleJob('*/5 * * * *', async () => { 
  console.log('Scheduled Check: Trying to clear orders if it is 12AM IST...');

  const currentIST = moment.tz('Asia/Kolkata');
  const currentHour = currentIST.hour();
  const currentMinute = currentIST.minute();

  // Only proceed if between 00:00 and 00:05 IST
  if (currentHour === 0 && currentMinute <= 5) {
    console.log('It is between 12:00-12:05AM IST. Proceeding with clearing...');

    try {
      const todayIST = moment.tz('Asia/Kolkata').startOf('day').toDate(); 
      const tomorrowIST = moment(todayIST).add(1, 'day').toDate();

      console.log(`Target Deletion Range [IST]: ${todayIST} to ${tomorrowIST}`);

      const ordersToDelete = await Order.find({
        date: {
          $gte: todayIST,
          $lt: tomorrowIST
        },
        status: 'completed'
      });

      console.log(`Found ${ordersToDelete.length} completed orders to delete.`);

      if (ordersToDelete.length > 0) {
        await Order.deleteMany({
          _id: { $in: ordersToDelete.map(o => o._id) }
        });
        console.log('Orders deleted successfully.');
      } else {
        console.log('No completed orders found for today. Nothing deleted.');
      }

    } catch (error) {
      console.error('Error during scheduled clearing:', error);
    }

  } else {
    console.log(`Current IST time is ${currentIST.format('HH:mm')}. Not time to clear yet.`);
  }
});



// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error occurred:', err.stack);
  res.status(500).json({ message: 'Something went wrong!' });
});

// 404 handler for undefined routes
app.use((req, res) => {
  console.log(`404 - Route not found: ${req.method} ${req.url}`);
  res.status(404).json({ message: 'Route not found' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log('Available routes:');
  console.log('- GET /health');
  console.log('- GET /api/orders');
  console.log('- GET /api/orders/completed');
  console.log('- GET /api/orders/total');
  console.log('- POST /api/orders');
});

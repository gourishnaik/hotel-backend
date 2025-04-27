const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const schedule = require('node-schedule');
const twilio = require('twilio');

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
  const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://gourishpnaik:vwAeuFmGNjFkeipb@hotel-be.wxnbm4u.mongodb.net/?retryWrites=true&w=majority&appName=hotel-be';
  
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
app.post('/api/orders', async (req, res) => {
  console.log('Received POST request to /api/orders');
  try {
    const orderData = req.body;
    if (orderData.id) {
      orderData.orderId = orderData.id;
      delete orderData.id;
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

// Calculate total amount endpoint
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

// Function to calculate grand total for the day
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

// Schedule SMS notification at 11 PM
schedule.scheduleJob('0 23 * * *', async () => {
  console.log('Sending daily total SMS notification...');
  const dailyTotal = await calculateDailyTotal();
  const message = `Daily Total for ${new Date().toLocaleDateString()}: ₹${dailyTotal.toFixed(2)}`;
  await sendSMS(message);
});

// Schedule data clearing at 8:29 AM
schedule.scheduleJob('29 8 * * *', async () => {
  console.log('Clearing daily data at 8:29 AM...');
  try {
    // Get current date in IST
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
    const istDate = new Date(now.getTime() + istOffset);
    
    // Set to start of day in IST
    const startOfDay = new Date(istDate);
    startOfDay.setHours(0, 0, 0, 0);
    startOfDay.setTime(startOfDay.getTime() - istOffset); // Convert back to UTC
    
    // Set to end of day in IST
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);
    endOfDay.setTime(endOfDay.getTime() - istOffset); // Convert back to UTC

    // Archive completed orders before deleting
    const ordersToArchive = await Order.find({
      date: {
        $gte: startOfDay,
        $lt: endOfDay
      },
      status: 'completed'
    });

    // TODO: Implement archiving logic if needed

    // Delete completed orders
    const deleteResult = await Order.deleteMany({
      date: {
        $gte: startOfDay,
        $lt: endOfDay
      },
      status: 'completed'
    });

    console.log(`Daily data cleared successfully at 8:29 AM. Deleted ${deleteResult.deletedCount} orders.`);
  } catch (error) {
    console.error('Error clearing daily data:', error);
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
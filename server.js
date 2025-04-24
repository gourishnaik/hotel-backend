const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

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
  const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://gourishpnaik:<db_password>@cluster0.g5kanb2.mongodb.net/hotel-billing?retryWrites=true&w=majority&appName=Cluster0';
  
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
  console.log('- POST /api/orders');
}); 
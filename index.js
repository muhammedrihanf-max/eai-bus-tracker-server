const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// REST endpoint so login page can validate driver credentials
app.get('/api/drivers', (req, res) => {
  res.json(drivers);
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const DRIVERS_FILE = path.join(__dirname, 'data', 'drivers.json');

// In-memory storage
let vehiclePositions = {};
let drivers = [];

// Persistence helpers
async function loadDrivers() {
  try {
    const data = await fs.readFile(DRIVERS_FILE, 'utf8');
    drivers = JSON.parse(data);
  } catch (error) {
    drivers = [];
    await saveDrivers();
  }
}

async function saveDrivers() {
  try {
    await fs.writeFile(DRIVERS_FILE, JSON.stringify(drivers, null, 2));
  } catch (error) {
    console.error('Error saving drivers:', error);
  }
}

loadDrivers();

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.emit('initial_positions', vehiclePositions);
  socket.emit('drivers_list', drivers);

  // CRUD Events
  socket.on('create_driver', async (newDriver) => {
    const driver = { ...newDriver, id: Date.now().toString() };
    drivers.push(driver);
    await saveDrivers();
    io.emit('drivers_list', drivers);
  });

  socket.on('update_driver', async (updatedDriver) => {
    drivers = drivers.map(d => d.id === updatedDriver.id ? updatedDriver : d);
    await saveDrivers();
    io.emit('drivers_list', drivers);
  });

  socket.on('delete_driver', async (driverId) => {
    drivers = drivers.filter(d => d.id !== driverId);
    await saveDrivers();
    io.emit('drivers_list', drivers);
  });

  socket.on('update_location', (data) => {
    const { vehicle_id, lat, lng, timestamp, speed, driver_name, role } = data;
    if (!vehicle_id) return;

    vehiclePositions[vehicle_id] = {
      lat, lng,
      timestamp: timestamp || Date.now(),
      speed: speed || 0,
      driver_name: driver_name || `Driver ${vehicle_id}`,
      role: role || 'driver',
      vehicle_id
    };

    io.emit('location_updated', vehiclePositions[vehicle_id]);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

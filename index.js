const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors());
app.use(express.json());

// REST endpoint so login page can validate driver credentials
app.get('/api/drivers', (req, res) => {
  res.json(drivers);
});

// Secure Admin Login
const ADMIN_HASH = process.env.ADMIN_PASSWORD_HASH || '$2b$10$VlAB6R5lplQkA9LDCyXu0ePWv71y5mH/KMU68W0Dn36QU8yuPnanm';

app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  try {
    const match = await bcrypt.compare(password, ADMIN_HASH);
    if (match) {
      res.json({ success: true, role: 'admin', name: 'Admin' });
    } else {
      res.status(401).json({ error: 'Invalid admin password' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Authentication error' });
  }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const DRIVERS_FILE = path.join(__dirname, 'data', 'drivers.json');
const STOPS_FILE = path.join(__dirname, 'data', 'stops.json');
const LOGS_FILE = path.join(__dirname, 'data', 'overspeed_logs.json');

// In-memory storage
let vehiclePositions = {};
let vehiclePaths = {}; // Stores arrays of {lat, lng}
let drivers = [];
let stops = [];
let overspeedLogs = [];
let socketToVehicle = {};

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

async function loadStops() {
  try {
    const data = await fs.readFile(STOPS_FILE, 'utf8');
    stops = JSON.parse(data);
  } catch (error) {
    stops = [];
    await saveStops();
  }
}

async function saveDrivers() {
  try {
    await fs.writeFile(DRIVERS_FILE, JSON.stringify(drivers, null, 2));
  } catch (error) {
    console.error('Error saving drivers:', error);
  }
}

async function saveStops() {
  try {
    await fs.writeFile(STOPS_FILE, JSON.stringify(stops, null, 2));
  } catch (error) {
    console.error('Error saving stops:', error);
  }
}

async function loadLogs() {
  try {
    const data = await fs.readFile(LOGS_FILE, 'utf8');
    overspeedLogs = JSON.parse(data);
  } catch (error) {
    overspeedLogs = [];
    await saveLogs();
  }
}

async function saveLogs() {
  try {
    await fs.writeFile(LOGS_FILE, JSON.stringify(overspeedLogs, null, 2));
  } catch (error) {
    console.error('Error saving logs:', error);
  }
}

loadDrivers();
loadStops();
loadLogs();

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.emit('initial_positions', vehiclePositions);
  socket.emit('drivers_list', drivers);
  socket.emit('stops_list', stops);
  socket.emit('overspeed_logs', overspeedLogs);

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
  
  // Stops Events
  socket.on('create_stop', async (newStop) => {
    const stop = { ...newStop, id: Date.now().toString() };
    stops.push(stop);
    await saveStops();
    io.emit('stops_list', stops);
  });

  socket.on('delete_stop', async (stopId) => {
    stops = stops.filter(s => s.id !== stopId);
    await saveStops();
    io.emit('stops_list', stops);
  });

  socket.on('update_location', (data) => {
    const { vehicle_id, lat, lng, timestamp, speed, driver_name, role } = data;
    if (!vehicle_id) return;

    vehiclePositions[vehicle_id] = {
      lat, lng,
      timestamp: timestamp || Date.now(),
      speed: speed || 0,
      driver_name: driver_name || `Driver ${vehicle_id}`,
      phone: data.phone || '', 
      role: role || 'driver',
      vehicle_id
    };

    // Log Overspeeding
    if (speed > 80 && role === 'driver') {
      const logEntry = {
        driver_name: driver_name || vehicle_id,
        vehicle_id,
        speed,
        lat, lng,
        timestamp: Date.now()
      };
      
      // Prevent duplicate logs (within 1 minute)
      const lastLog = overspeedLogs.find(l => l.vehicle_id === vehicle_id && (Date.now() - l.timestamp < 60000));
      if (!lastLog) {
        overspeedLogs.push(logEntry);
        saveLogs();
        io.emit('overspeed_logs', overspeedLogs);
      }
    }

    // Update Path (Traveled Trail)
    if (!vehiclePaths[vehicle_id]) {
      vehiclePaths[vehicle_id] = [];
    }
    
    // Only add if different from last point
    const currentPath = vehiclePaths[vehicle_id];
    const lastPoint = currentPath[currentPath.length - 1];
    if (!lastPoint || lastPoint[0] !== lat || lastPoint[1] !== lng) {
      currentPath.push([lat, lng]);
      // Limit path length to last 100 points
      if (currentPath.length > 100) {
        currentPath.shift();
      }
    }

    io.emit('location_updated', {
      ...vehiclePositions[vehicle_id],
      path: currentPath
    });

    socketToVehicle[socket.id] = vehicle_id;
  });

  socket.on('logout', (vehicleId) => {
    if (vehicleId) {
      delete vehiclePositions[vehicleId];
      delete vehiclePaths[vehicleId];
      io.emit('vehicle_removed', vehicleId);
      console.log(`Vehicle ${vehicleId} logged out and path cleared.`);
    }
  });

  socket.on('disconnect', () => {
    const vehicleId = socketToVehicle[socket.id];
    if (vehicleId) {
      delete vehiclePositions[vehicleId];
      delete vehiclePaths[vehicleId];
      io.emit('vehicle_removed', vehicleId);
      delete socketToVehicle[socket.id];
      console.log(`Socket disconnected: Vehicle ${vehicleId} removed.`);
    }
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

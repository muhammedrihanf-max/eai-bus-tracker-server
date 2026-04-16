const { io } = require('socket.io-client');
const socket = io('http://localhost:3001');

socket.on('connect', () => {
  console.log('Connected to server');
  socket.emit('create_driver', {
    driver_name: 'Socket Test',
    vehicle_id: 'TEST-999',
    role: 'driver'
  });
});

socket.on('drivers_list', (drivers) => {
  console.log('Received drivers_list:', drivers);
  const found = drivers.find(d => d.driver_name === 'Socket Test');
  if (found) {
    console.log('SUCCESS: Driver found in list!');
    process.exit(0);
  }
});

setTimeout(() => {
  console.log('TIMEOUT: Driver not found in list');
  process.exit(1);
}, 5000);

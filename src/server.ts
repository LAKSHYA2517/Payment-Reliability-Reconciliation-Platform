import express from "express";
import { Payemnt } from "./types";

const app=express();

app.use(express.json());

app.get("/",(req,res)=>{
    res.json({
        message:"Payment API is running"
    });
});

app.get("/payments",(req,res)=>{
    const payment:Payemnt=req.body;
    
    res.json({
        message:"Payment recieved",
        payment
    });
});


app.listen(3000,()=>{
    console.log("Server is running on port 3000");
})
